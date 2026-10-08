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
 * 4. @mesh(guard) with claims check (dominion over the document's workspace)
 * 5. @mesh(guard) with instance state (allowed editors)
 * 6. Reusable guards (requireSubscriber pattern)
 * 7. A guard that computes its own decision from the caller and the node's storage
 *
 * Every user logs in on one workspace's page through Mesh's Registry, which hands the magic link
 * back in test mode (ADR-009 rung 2). The workspace's first login is its admin; each later one is
 * invited and is a plain member.
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { SecurityClient, type TeamDocResult } from './security-client.js';
import { LoginRequiredError } from '../../../src/index.js';
import type { TeamDocDO } from './team-doc-do.js';
import type { WorkspaceDO } from '../security/index.js';
import { loginAt, uniqueScope } from '../../support/login.js';

/**
 * Capture what the client's `@mesh()` TeamDocDO handler receives.
 *
 * The capture lives here rather than on `SecurityClient` so the doc-facing
 * fixture stays free of test plumbing. Call once per client — patching twice
 * would nest the wrappers and push each result into both arrays.
 */
function captureTeamDocResults(client: SecurityClient): Array<TeamDocResult | Error> {
  const results: Array<TeamDocResult | Error> = [];
  const original = client.handleTeamDocResponse.bind(client);
  (client as any).handleTeamDocResponse = (result: TeamDocResult | Error) => {
    results.push(result);
    original(result);
  };
  return results;
}

/**
 * Fire one guarded call and return what came back — the value on success, the
 * guard's Error on refusal. Mesh calls are one-way, so the outcome arrives at
 * the client's result handler instead of being thrown or returned here.
 */
async function drive(
  results: Array<TeamDocResult | Error>,
  fire: () => void
): Promise<TeamDocResult | Error> {
  const before = results.length;
  fire();
  await vi.waitFor(() => {
    expect(results.length).toBe(before + 1);
  });
  return results[before];
}

it('security patterns: auth, guards, and a guard that computes its own decision', async () => {
  const workspace = uniqueScope('acme');
  // The workspace's founder, its admin
  const adminLogin = await loginAt(workspace);

  // ============================================
  // Phase 1: onLoginRequired callback
  // ============================================
  // Demonstrates that when auth fails (e.g., token expiration close code),
  // the onLoginRequired callback is invoked.

  const aliceBrowser = new Browser();
  const aliceLogin = await loginAt(workspace);
  const aliceUserId = aliceLogin.sub;
  const aliceRefresh = aliceLogin.refresh;

  // Track login required errors
  const loginRequiredErrors: LoginRequiredError[] = [];

  using alice = new SecurityClient({
    instanceName: `${aliceUserId}.tab1`,
    baseUrl: aliceLogin.baseUrl,
    refresh: aliceRefresh,
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
  // (4401 would attempt refresh first, which succeeds because Alice's session is live)
  {
    using hostClient = createTestingClient<typeof WorkspaceDO>('WORKSPACE_DO', workspace);
    // Force close with 4403 (invalid signature) - this triggers onLoginRequired directly
    const sockets = await hostClient.ctx.getWebSockets(`${workspace}/${aliceUserId}.tab1`);
    await sockets[0].close(4403, 'Invalid token signature');
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
  // UserProfileDO demonstrates owner-only access:
  // - Owner (sub matches instance name) can access
  // - Everyone else gets "Access denied", the workspace's admin included (Phase 4)

  const bobBrowser = new Browser();
  const bobLogin = await loginAt(workspace);
  const bobUserId = bobLogin.sub;
  const bobRefresh = bobLogin.refresh;

  using bob = new SecurityClient({
    instanceName: `${bobUserId}.tab1`,
    baseUrl: bobLogin.baseUrl,
    refresh: bobRefresh,
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

  // …and is refused at someone else's: the guard's other half.
  bob.callUserProfile(adminLogin.sub);
  await vi.waitFor(() => {
    expect(profileCallResults.length).toBe(2);
  });
  expect(profileCallResults[1]).toBeInstanceOf(Error);
  expect((profileCallResults[1] as Error).message).toContain('Access denied');

  // ============================================
  // Phase 4: @mesh(guard) with claims check (admin only)
  // ============================================
  // The adminMethod guard checks that the caller holds dominion over the workspace the document
  // was created in. Bob, an invited member, is refused; the workspace's founder, its admin, gets
  // through; and the founder of another workspace, an admin there, is refused here.
  //
  // ⚠️ This also pins the WIRE FORMAT end to end: the host copies the whole verified payload into
  // `originAuth.claims`, so the Registry's `access` claim arrives as the guard reads it. Driven over
  // the real path — real client → Worker fetch → `hostedUpgrade` → the host node → DO.

  const adminCallResults: Array<string | Error> = [];

  // Bob is NOT an admin — his call must be refused by the guard.
  const originalAdminHandler = bob.handleAdminResponse.bind(bob);
  (bob as any).handleAdminResponse = (result: any) => {
    adminCallResults.push(result);
    originalAdminHandler(result);
  };

  // Created from the workspace's page, so the document belongs to the workspace.
  const adminDocId = crypto.randomUUID();
  await bob.lmz.callAsync('TEAM_DOC_DO', adminDocId, bob.ctn<TeamDocDO>().create(), { timeoutMs: 10_000 });
  bob.callAdminMethod(adminDocId);

  await vi.waitFor(() => {
    expect(adminCallResults.length).toBe(1);
  });

  expect(adminCallResults[0]).toBeInstanceOf(Error);
  expect((adminCallResults[0] as Error).message).toContain('Admin only');

  // An admin — same path, but the token's membership is the workspace's admin.
  const adminBrowser = new Browser();
  const adminUserId = adminLogin.sub;
  const adminRefresh = adminLogin.refresh;

  using adminUser = new SecurityClient({
    instanceName: `${adminUserId}.tab1`,
    baseUrl: adminLogin.baseUrl,
    refresh: adminRefresh,
    fetch: adminBrowser.fetch,
    WebSocket: adminBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(adminUser.connectionState).toBe('connected');
  });

  const adminOwnResults: Array<string | Error> = [];
  const originalOwnHandler = adminUser.handleAdminResponse.bind(adminUser);
  (adminUser as any).handleAdminResponse = (result: any) => {
    adminOwnResults.push(result);
    originalOwnHandler(result);
  };

  adminUser.callAdminMethod(adminDocId);

  await vi.waitFor(() => {
    expect(adminOwnResults.length).toBe(1);
  });

  expect(adminOwnResults[0]).not.toBeInstanceOf(Error);
  expect(adminOwnResults[0]).toBe('admin-only-result');

  // The workspace's admin holds no ownership of Bob's profile: UserProfileDO has no admin.
  const adminProfileResults: Array<{ message: string; sub: string } | Error> = [];
  const originalAdminProfileHandler = adminUser.handleProfileResponse.bind(adminUser);
  (adminUser as any).handleProfileResponse = (result: any) => {
    adminProfileResults.push(result);
    originalAdminProfileHandler(result);
  };
  adminUser.callUserProfile(bobUserId);
  await vi.waitFor(() => {
    expect(adminProfileResults.length).toBe(1);
  });
  expect(adminProfileResults[0]).toBeInstanceOf(Error);
  expect((adminProfileResults[0] as Error).message).toContain('Access denied');

  // The founder of ANOTHER workspace holds `scopeAdmin` too, at that workspace, and is refused here:
  // the guard asks about dominion over this document's workspace, never about the bit alone.
  const otherLogin = await loginAt(uniqueScope('other'));
  const otherBrowser = new Browser();
  using otherFounder = new SecurityClient({
    instanceName: `${otherLogin.sub}.tab1`,
    baseUrl: otherLogin.baseUrl,
    refresh: otherLogin.refresh,
    fetch: otherBrowser.fetch,
    WebSocket: otherBrowser.WebSocket,
  });
  await vi.waitFor(() => {
    expect(otherFounder.connectionState).toBe('connected');
  });
  const otherResults: Array<string | Error> = [];
  const originalOtherHandler = otherFounder.handleAdminResponse.bind(otherFounder);
  (otherFounder as any).handleAdminResponse = (result: any) => {
    otherResults.push(result);
    originalOtherHandler(result);
  };
  otherFounder.callAdminMethod(adminDocId);
  await vi.waitFor(() => {
    expect(otherResults.length).toBe(1);
  });
  expect(otherResults[0]).toBeInstanceOf(Error);
  expect((otherResults[0] as Error).message).toContain('Admin only');

  // ============================================
  // Phase 5: @mesh(guard) with instance state (allowed editors)
  // ============================================
  // updateDocument's guard reads `instance.allowedEditors` directly. Carol is
  // refused until she's added, then gets through.
  //
  // ⚠️ Both halves are driven from a real client, because a guard runs ONLY on
  // the mesh entry check — a `createTestingClient` call would execute
  // updateDocument's body with the guard never consulted, which is a test of
  // the method, not of the guard it demonstrates.

  const carolBrowser = new Browser();
  const carolLogin = await loginAt(workspace);
  const carolUserId = carolLogin.sub;
  const carolRefresh = carolLogin.refresh;

  using carol = new SecurityClient({
    instanceName: `${carolUserId}.tab1`,
    baseUrl: carolLogin.baseUrl,
    refresh: carolRefresh,
    fetch: carolBrowser.fetch,
    WebSocket: carolBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(carol.connectionState).toBe('connected');
  });

  const carolResults = captureTeamDocResults(carol);
  // Team documents are named by an id, never by a scope
  const editorDocId = crypto.randomUUID();
  const subscriberDocId = crypto.randomUUID();

  // Carol is not yet an allowed editor — the guard refuses her.
  const refusedUpdate = await drive(carolResults, () =>
    carol.callUpdateDocument(editorDocId, 'Carol was here')
  );
  expect(refusedUpdate).toBeInstanceOf(Error);
  expect((refusedUpdate as Error).message).toContain('Not an allowed editor');

  // Seeding + reading storage is what createTestingClient IS for: addEditor is
  // reachable over the mesh, but the `allowedEditors` getter has no @mesh().
  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', editorDocId);

    // Add Carol as an allowed editor
    await teamDocClient.addEditor(carolUserId);

    // Verify the editor was added
    const editors = await teamDocClient.allowedEditors;
    expect(editors.has(carolUserId)).toBe(true);
  }

  // Same call, same path — now the guard passes.
  const updateResult = await drive(carolResults, () =>
    carol.callUpdateDocument(editorDocId, 'Carol was here')
  );
  expect(updateResult).toEqual({ updated: true, content: 'Carol was here' });

  // ...and the write actually landed. Asserting only on the returned value
  // can't tell a real write from a method that just reports success.
  const storedContent = await drive(carolResults, () => carol.callGetContent(editorDocId));
  expect(storedContent).toBe('Carol was here');

  // ============================================
  // Phase 6: Reusable guards (requireSubscriber pattern)
  // ============================================
  // The requireSubscriber guard checks originAuth.sub against the
  // subscribers Set in DO storage — combining JWT identity with instance state.
  // originAuth only exists on the real path, so both methods sharing the guard
  // are driven from Bob's client.

  const bobResults = captureTeamDocResults(bob);

  // Bob is not subscribed yet.
  const refusedEdit = await drive(bobResults, () =>
    bob.callEditDocument(subscriberDocId, 'Team doc content')
  );
  expect(refusedEdit).toBeInstanceOf(Error);
  expect((refusedEdit as Error).message).toContain('Subscriber access required');

  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', subscriberDocId);

    // Add Bob as a subscriber
    await teamDocClient.addSubscriber(bobUserId);

    // Verify subscriber was added
    const subs = await teamDocClient.subscribers;
    expect(subs.has(bobUserId)).toBe(true);
  }

  // Both editDocument and addComment use requireSubscriber —
  // Bob can call them because he's subscribed
  const editResult = await drive(bobResults, () =>
    bob.callEditDocument(subscriberDocId, 'Team doc content')
  );
  expect(editResult).toEqual({ edited: true, content: 'Team doc content' });

  const commentResult = await drive(bobResults, () =>
    bob.callAddComment(subscriberDocId, 'Looks good!')
  );
  expect(commentResult).toEqual({ commented: true });

  // ============================================
  // Phase 7: a guard computes its own decision
  // ============================================
  // The editAsEditor guard checks the caller's sub against the node's allowedEditors. A guard runs
  // only on the mesh path, so this phase is meaningless from a testing client.

  // Bob is not an editor of this instance, so the guard refuses.
  const refusedEditorEdit = await drive(bobResults, () =>
    bob.callEditAsEditor(editorDocId, 'Editor-gated edit')
  );
  expect(refusedEditorEdit).toBeInstanceOf(Error);
  expect((refusedEditorEdit as Error).message).toContain('Editor access required');

  {
    using teamDocClient = createTestingClient<typeof TeamDocDO>('TEAM_DOC_DO', editorDocId);

    // Initially Bob is not an editor
    const editorsBefore = await teamDocClient.allowedEditors;
    expect(editorsBefore.has(bobUserId)).toBe(false);

    // Add Bob as an editor
    await teamDocClient.addEditor(bobUserId);

    // Verify editor was added
    const editorsAfter = await teamDocClient.allowedEditors;
    expect(editorsAfter.has(bobUserId)).toBe(true);
  }

  // Now Bob is an editor, and the guard passes.
  const editorEditResult = await drive(bobResults, () =>
    bob.callEditAsEditor(editorDocId, 'Editor-gated edit')
  );
  expect(editorEditResult).toEqual({ edited: true, byUser: bobUserId });

  // ============================================
  // Cleanup
  // ============================================
  // Clients auto-disconnect via `using`
});

/**
 * Test: 4401 (token expired) → refresh fails → onLoginRequired fires.
 *
 * Distinct from Phase 1's 4403 test: 4403 skips refresh entirely and fires
 * onLoginRequired directly. Here, 4401 triggers a refresh attempt first —
 * this test proves that when refresh *fails*, onLoginRequired fires correctly.
 */
it('4401 close triggers refresh, which fails, then fires onLoginRequired', async () => {
  const workspace = uniqueScope('acme');
  const login = await loginAt(workspace);
  const userId = login.sub;

  // The refresh route, counted: the user logs out below, so every refresh after that one fails
  let callCount = 0;
  const refresh = async () => {
    callCount++;
    return login.refresh();
  };

  const browser = new Browser();
  const loginRequiredErrors: LoginRequiredError[] = [];

  using client = new SecurityClient({
    instanceName: `${userId}.tab1`,
    baseUrl: login.baseUrl,
    refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    onLoginRequired: (error) => {
      loginRequiredErrors.push(error);
    },
  });

  // Wait for initial connection
  await vi.waitFor(() => {
    expect(client.connectionState).toBe('connected');
  });
  expect(callCount).toBe(1);

  // The session ends: logout revokes the refresh cookie, so the refresh route now answers 401
  await login.logout();

  // Force close with 4401 (token expired) — client will attempt refresh, which throws
  {
    using hostClient = createTestingClient<typeof WorkspaceDO>('WORKSPACE_DO', workspace);
    const sockets = await hostClient.ctx.getWebSockets(`${workspace}/${userId}.tab1`);
    await sockets[0].close(4401, 'Token expired');
  }

  // onLoginRequired should fire after refresh fails
  await vi.waitFor(() => {
    expect(loginRequiredErrors.length).toBe(1);
  });

  expect(loginRequiredErrors[0]).toBeInstanceOf(LoginRequiredError);
  expect(loginRequiredErrors[0].code).toBe(401);
  expect(loginRequiredErrors[0].reason).toBe('Refresh token expired or invalid');
  expect(client.connectionState).toBe('disconnected');
  expect(callCount).toBe(2); // initial + failed refresh attempt
});

/**
 * Negative security test: verify that forged/invalid JWTs are rejected
 * by the Worker's `hostedUpgrade` BEFORE reaching the host node.
 *
 * The host node's own tests use fake JWTs (since the host trusts the Worker),
 * but this test proves the Worker actually blocks invalid tokens.
 */
it('Worker rejects forged JWT before it reaches the host node', async () => {
  const browser = new Browser();
  const page = `http://${uniqueScope('acme')}.lumenize.localhost`;

  // Attempt WebSocket upgrade with a completely forged JWT — its signature does not verify
  const forgedToken = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.not-a-real-signature';
  const response = await browser.fetch(`${page}/gateway/forged-user.tab1`, {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': `lmz.2, lmz.access-token.${forgedToken}`,
    },
  });

  // Refused before routing — a token that does not verify never reaches the host
  expect(response.status).toBe(403);

  // Also verify: no token at all
  const noTokenResponse = await browser.fetch(`${page}/gateway/no-token.tab1`, {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz.2',
    },
  });

  expect(noTokenResponse.status).toBe(401);
});
