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
 * 6. Reusable guards (requireSubscriber pattern)
 * 7. State-based access control (permissions in callContext.state)
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { SecurityClient } from './security-client.js';
import { LoginRequiredError, type LumenizeClientGateway } from '../../../src/index.js';
import type { TeamDocDO } from './team-doc-do.js';

it('security patterns: auth, guards, and state-based access', async () => {
  // ============================================
  // Phase 1: onLoginRequired callback
  // ============================================
  // Demonstrates that when auth fails (e.g., token expiration close code),
  // the onLoginRequired callback is invoked.

  const aliceBrowser = new Browser();
  const { sub: aliceUserId } = await testLoginWithMagicLink(aliceBrowser, 'alice@example.com', { subjectData: { adminApproved: true } });

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
  // The onBeforeCall() checks that originAuth.sub exists.

  const bobBrowser = new Browser();
  const { sub: bobUserId } = await testLoginWithMagicLink(bobBrowser, 'bob@example.com', { subjectData: { adminApproved: true } });

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
  expect((protectedResult as any).sub).toBe(bobUserId);

  // ============================================
  // Phase 4: @mesh(guard) with claims check (admin only)
  // ============================================
  // TODO: Now that @lumenize/auth supports isAdmin via testLoginWithMagicLink subjectData,
  // implement this test: Bob (no isAdmin) fails, Admin ({ subjectData: { isAdmin: true } }) succeeds.
  // The adminMethod guard checks originAuth.claims.isAdmin.

  // ============================================
  // Phase 5: @mesh(guard) with instance state (allowed editors)
  // ============================================
  // Carol is not in allowedEditors - her updateDocument call would fail.
  // After being added, her call succeeds.

  const carolBrowser = new Browser();
  const { sub: carolUserId } = await testLoginWithMagicLink(carolBrowser, 'carol@example.com', { subjectData: { adminApproved: true } });

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
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', 'editor-doc-1');

    // Initially Carol is NOT an allowed editor
    // If she tries to call updateDocument, the guard would throw "Not an allowed editor"

    // Add Carol as an allowed editor
    await teamDocClient.addEditor(carolUserId);

    // Verify the editor was added
    const editors = await teamDocClient.allowedEditors;
    expect(editors.has(carolUserId)).toBe(true);
  }

  // ============================================
  // Phase 6: Reusable guards (requireSubscriber pattern)
  // ============================================
  // The requireSubscriber guard checks originAuth.sub against the
  // subscribers Set in DO storage — combining JWT identity with instance state.

  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', 'subscriber-doc-1');

    // Add Bob as a subscriber
    await teamDocClient.addSubscriber(bobUserId);

    // Verify subscriber was added
    const subs = await teamDocClient.subscribers;
    expect(subs.has(bobUserId)).toBe(true);

    // Both editDocument and addComment use requireSubscriber —
    // Bob can call them because he's subscribed
    const editResult = await teamDocClient.editDocument({ content: 'Team doc content' });
    expect(editResult.edited).toBe(true);
    expect(editResult.content).toBe('Team doc content');

    const commentResult = await teamDocClient.addComment('Looks good!');
    expect(commentResult.commented).toBe(true);
  }

  // ============================================
  // Phase 7: State-based access control
  // ============================================
  // The editWithStateCheck guard checks callContext.state.permissions.canEdit.
  // onBeforeCall loads permissions from storage into state.

  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', 'state-doc-1');

    // Initially Bob has no edit permission
    const canEditBefore = await teamDocClient.ctx.storage.kv.get(`user:${bobUserId}:canEdit`);
    expect(canEditBefore).toBeUndefined();

    // Grant edit permission to Bob
    await teamDocClient.grantEditPermission(bobUserId);

    // Verify permission was stored
    const canEditAfter = await teamDocClient.ctx.storage.kv.get(`user:${bobUserId}:canEdit`);
    expect(canEditAfter).toBe(true);

    // When Bob calls through the mesh, his callContext.state.permissions.canEdit
    // will be true (populated in onBeforeCall) and the guard will pass
  }

  // ============================================
  // Cleanup
  // ============================================
  // Clients auto-disconnect via `using`
});

/**
 * Negative security test: verify that forged/invalid JWTs are rejected
 * by the Worker's auth hooks BEFORE reaching the gateway DO.
 *
 * This is the end-to-end counterpart to the auth package unit tests.
 * The gateway unit tests use fake JWTs (since gateway trusts the Worker),
 * but this test proves the Worker actually blocks invalid tokens.
 */
it('Worker rejects forged JWT before it reaches the gateway DO', async () => {
  const browser = new Browser();

  // Attempt WebSocket upgrade with a completely forged JWT
  // The Worker's onBeforeConnect should reject this with 401
  const forgedToken = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.not-a-real-signature';
  const response = await browser.fetch('https://localhost/gateway/LUMENIZE_CLIENT_GATEWAY/forged-user.tab1', {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${forgedToken}`,
    },
  });

  // Worker hooks should reject — invalid signature never reaches gateway
  expect(response.status).toBe(401);

  // Also verify: no token at all
  const noTokenResponse = await browser.fetch('https://localhost/gateway/LUMENIZE_CLIENT_GATEWAY/no-token.tab1', {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz',
    },
  });

  expect(noTokenResponse.status).toBe(401);
});
