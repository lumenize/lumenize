/**
 * Security test: Authentication and Authorization patterns
 *
 * This single long-running test demonstrates the security patterns from
 * website/docs/mesh/security.mdx in a realistic scenario.
 *
 * Phases covered:
 * 1. onLoginRequired callback when auth fails
 * 2. onBeforeCall() blocking unauthenticated access
 * 3. Authenticated user accessing protected resources
 * 4. @mesh(guard) with claims check (admin only)
 * 5. @mesh(guard) with instance state (allowed editors)
 * 6. Reusable guards (requireRole pattern)
 * 7. State-based access control (permissions in callContext.state)
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { SecurityClient } from './security-client.js';
import { LoginRequiredError, type LumenizeClientGateway } from '../../../src/index.js';
import type { GuardedDO } from './guarded-do.js';

it('security patterns: auth, guards, and state-based access', async () => {
  // ============================================
  // Phase 1: onLoginRequired callback
  // ============================================
  // Demonstrates that when auth fails (e.g., token expiration close code),
  // the onLoginRequired callback is invoked.

  const aliceBrowser = new Browser();
  const aliceUserId = await testLoginWithMagicLink(aliceBrowser, 'alice@example.com');

  // Track login required errors
  const loginRequiredErrors: LoginRequiredError[] = [];

  using alice = new SecurityClient({
    instanceName: `${aliceUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    fetch: aliceBrowser.fetch,
    WebSocket: aliceBrowser.WebSocket,
    onLoginRequired: (error) => {
      // Only fires when refresh fails — user must re-login
      console.log('Login required:', error.code, error.reason);
      loginRequiredErrors.push(error);
    },
  });

  // Wait for connection
  await vi.waitFor(() => {
    expect(alice.connectionState).toBe('connected');
  });

  // Use testing client to force close the WebSocket with auth error code
  // Code 4403 (invalid signature) triggers onLoginRequired directly without refresh attempt
  // (4401 would attempt refresh first, which succeeds in test mode)
  {
    using gatewayClient = createTestingClient<typeof LumenizeClientGateway>(
      'LUMENIZE_CLIENT_GATEWAY',
      `${aliceUserId}.tab1`
    );
    // Force close with 4403 (invalid signature) - this triggers onLoginRequired directly
    await (gatewayClient as any).__testForceClose(4403, 'Invalid token signature');
  }

  // Verify onLoginRequired was called
  await vi.waitFor(() => {
    expect(loginRequiredErrors.length).toBe(1);
  });

  expect(loginRequiredErrors[0]).toBeInstanceOf(LoginRequiredError);
  expect(loginRequiredErrors[0].code).toBe(4403);
  expect(loginRequiredErrors[0].reason).toBe('Invalid token signature');
  expect(alice.connectionState).toBe('disconnected');

  // ============================================
  // Phase 2 & 3: onBeforeCall() and authenticated access
  // ============================================
  // Bob is authenticated, so he can access ProtectedDO.
  // The onBeforeCall() checks that originAuth.userId exists.

  const bobBrowser = new Browser();
  const bobUserId = await testLoginWithMagicLink(bobBrowser, 'bob@example.com');

  using bob = new SecurityClient({
    instanceName: `${bobUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    fetch: bobBrowser.fetch,
    WebSocket: bobBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(bob.connectionState).toBe('connected');
  });

  // Make a call through the mesh to verify authenticated access works
  const protectedCallResults: Array<{ message: string; userId: string } | Error> = [];

  // Capture results via the handler
  const originalHandler = bob.handleProtectedResponse.bind(bob);
  (bob as any).handleProtectedResponse = (result: any) => {
    protectedCallResults.push(result);
    originalHandler(result);
  };

  bob.callProtectedDO('protected-doc-1');

  await vi.waitFor(() => {
    expect(protectedCallResults.length).toBe(1);
  });

  // Should succeed for authenticated user
  const protectedResult = protectedCallResults[0];
  expect(protectedResult).not.toBeInstanceOf(Error);
  expect((protectedResult as any).message).toBe('Protected data');
  expect((protectedResult as any).userId).toBe(bobUserId);

  // ============================================
  // Phase 4: @mesh(guard) with claims check (admin only)
  // ============================================
  // TODO: Requires custom claims support in @lumenize/auth
  // The adminMethod guard checks originAuth.claims.isAdmin.
  // Once @lumenize/auth supports custom claims in testLoginWithMagicLink,
  // we can test: Bob (no isAdmin) fails, Admin (isAdmin: true) succeeds.

  // ============================================
  // Phase 5: @mesh(guard) with instance state (allowed editors)
  // ============================================
  // Carol is not in allowedEditors - her updateDocument call would fail.
  // After being added, her call succeeds.

  const carolBrowser = new Browser();
  const carolUserId = await testLoginWithMagicLink(carolBrowser, 'carol@example.com');

  using carol = new SecurityClient({
    instanceName: `${carolUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    fetch: carolBrowser.fetch,
    WebSocket: carolBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(carol.connectionState).toBe('connected');
  });

  // Use testing client to set up and verify guard behavior
  {
    using guardedClient = createTestingClient<typeof GuardedDO>('GUARDED_DO', 'editor-doc-1');

    // Initially Carol is NOT an allowed editor
    // If she tries to call updateDocument, the guard would throw "Not an allowed editor"

    // Add Carol as an allowed editor
    await guardedClient.addEditor(carolUserId);

    // Verify the editor was added
    const editors = await guardedClient.allowedEditors;
    expect(editors.has(carolUserId)).toBe(true);
  }

  // ============================================
  // Phase 6: Reusable guards (requireRole pattern)
  // ============================================
  // TODO: Requires custom claims support in @lumenize/auth
  // The requireRole guard checks originAuth.claims.roles.
  // Once @lumenize/auth supports custom claims, we can test:
  // Bob (no roles) fails editDocument, Admin (roles: ['editor']) succeeds.

  // ============================================
  // Phase 7: State-based access control
  // ============================================
  // The editWithStateCheck guard checks callContext.state.permissions.canEdit.
  // onBeforeCall loads permissions from storage into state.

  {
    using guardedClient = createTestingClient<typeof GuardedDO>('GUARDED_DO', 'state-doc-1');

    // Initially Bob has no edit permission
    const canEditBefore = await guardedClient.ctx.storage.kv.get(`user:${bobUserId}:canEdit`);
    expect(canEditBefore).toBeUndefined();

    // Grant edit permission to Bob
    await guardedClient.grantEditPermission(bobUserId);

    // Verify permission was stored
    const canEditAfter = await guardedClient.ctx.storage.kv.get(`user:${bobUserId}:canEdit`);
    expect(canEditAfter).toBe(true);

    // When Bob calls through the mesh, his callContext.state.permissions.canEdit
    // will be true (populated in onBeforeCall) and the guard will pass
  }

  // ============================================
  // Cleanup
  // ============================================
  // Clients auto-disconnect via `using`
});
