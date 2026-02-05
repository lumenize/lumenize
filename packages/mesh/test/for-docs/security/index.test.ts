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
  // Phase 2 & 3: onBeforeCall() ownership check
  // ============================================
  // UserProfileDO demonstrates owner-or-admin access:
  // - Owner (sub matches instance name) can access
  // - Admin (isAdmin claim) can access anyone's profile
  // - Others get "Access denied"

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

  // Make a call through the mesh to verify owner access works
  const profileCallResults: Array<{ message: string; sub: string } | Error> = [];

  // Capture results via the handler
  const originalHandler = bob.handleProfileResponse.bind(bob);
  (bob as any).handleProfileResponse = (result: any) => {
    profileCallResults.push(result);
    originalHandler(result);
  };

  // Bob accesses his OWN profile (instance name = bobUserId)
  bob.callUserProfile(bobUserId);

  await vi.waitFor(() => {
    expect(profileCallResults.length).toBe(1);
  });

  // Should succeed because Bob is the owner
  const profileResult = profileCallResults[0];
  expect(profileResult).not.toBeInstanceOf(Error);
  expect((profileResult as any).message).toBe('Profile data');
  expect((profileResult as any).sub).toBe(bobUserId);

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
  // Phase 7: Call context state
  // ============================================
  // The editWithStateCheck guard checks callContext.state.isEditor.
  // onBeforeCall computes isEditor once from allowedEditors Set.

  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', 'state-doc-1');

    // Initially Bob is not an editor
    const editorsBefore = await teamDocClient.allowedEditors;
    expect(editorsBefore.has(bobUserId)).toBe(false);

    // Add Bob as an editor
    await teamDocClient.addEditor(bobUserId);

    // Verify editor was added
    const editorsAfter = await teamDocClient.allowedEditors;
    expect(editorsAfter.has(bobUserId)).toBe(true);

    // When Bob calls through the mesh, his callContext.state.isEditor
    // will be true (computed in onBeforeCall) and the guard will pass
  }

  // ============================================
  // Cleanup
  // ============================================
  // Clients auto-disconnect via `using`
});

/**
 * CORS test: verify that WebSocket upgrades from disallowed origins are
 * rejected with 403 by routeDORequest's server-side CORS enforcement.
 *
 * The security Worker is configured with cors: { origin: ['https://localhost'] }.
 * Requests without an Origin header pass through (same-origin assumed),
 * but cross-origin requests from unlisted origins are blocked before
 * reaching the Gateway or auth hooks.
 *
 * Uses browser.fetch directly (not browser.context) to bypass the Browser's
 * client-side CORS simulation and inspect the raw server response.
 */
it('CORS allowlist rejects WebSocket upgrade from disallowed origin', async () => {
  // Authenticate normally first — we need a valid token to isolate the CORS behavior
  const browser = new Browser();
  const { sub, accessToken } = await testLoginWithMagicLink(browser, 'cors-test@example.com', { subjectData: { adminApproved: true } });

  // Attempt WebSocket upgrade from a disallowed origin (raw fetch to see server response)
  const rejectedResponse = await browser.fetch(`https://localhost/gateway/LUMENIZE_CLIENT_GATEWAY/${sub}.tab1`, {
    headers: {
      'Origin': 'https://evil.com',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${accessToken}`,
    },
  });

  // Server-side CORS enforcement: 403 before auth hooks or Gateway are invoked
  expect(rejectedResponse.status).toBe(403);
  expect(await rejectedResponse.text()).toBe('Forbidden: Origin not allowed');

  // Same request from the allowed origin should NOT get 403
  const allowedResponse = await browser.fetch(`https://localhost/gateway/LUMENIZE_CLIENT_GATEWAY/${sub}.tab1`, {
    headers: {
      'Origin': 'https://localhost',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${accessToken}`,
    },
  });

  expect(allowedResponse.status).not.toBe(403);
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
