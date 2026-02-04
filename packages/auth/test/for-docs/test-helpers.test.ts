/**
 * Documentation validation tests for testLoginWithMagicLink examples
 *
 * Each it() block contains doc code verbatim so the @check-example plugin
 * finds it as a substring after normalization.
 */
import { describe, it, expect } from 'vitest';
import { testLoginWithMagicLink, parseJwtUnsafe } from '@lumenize/auth';
import { Browser } from '@lumenize/testing';

describe('testLoginWithMagicLink Examples', () => {

  // Matches index.mdx:403 — Basic login, admin login, and delegation
  it('basic login, admin login, and delegation', async () => {
    // Pre-setup: authorize actor for alice (the doc example assumes prior authorization)
    const setupAdminBrowser = new Browser();
    const { accessToken: setupAdminToken } = await testLoginWithMagicLink(setupAdminBrowser, 'setup-admin@test.com', {
      subjectData: { isAdmin: true }
    });
    const setupAliceBrowser = new Browser();
    const { sub: aliceSub } = await testLoginWithMagicLink(setupAliceBrowser, 'alice@test.com', {
      subjectData: { adminApproved: true }
    });
    const setupActorBrowser = new Browser();
    const { sub: actorSub } = await testLoginWithMagicLink(setupActorBrowser, 'actor@test.com', {
      subjectData: { adminApproved: true }
    });
    await setupAdminBrowser.fetch(`https://localhost/auth/subject/${aliceSub}/actors`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${setupAdminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ actorSub: actorSub })
    });

    // --- Doc code from index.mdx:403 ---

    const browser = new Browser();

    // Login as approved regular subject
    const { accessToken, sub } = await testLoginWithMagicLink(browser, 'alice@test.com', {
      subjectData: { adminApproved: true }  // emailVerified is set automatically
    });

    // Login as admin
    const adminBrowser = new Browser();
    const { accessToken: adminToken } = await testLoginWithMagicLink(adminBrowser, 'admin@test.com', {
      subjectData: { isAdmin: true }  // Admins implicitly have adminApproved
    });

    // Login with delegation — alice is the principal, the actor acts on her behalf
    const actorBrowser = new Browser();
    const { accessToken: actorToken } = await testLoginWithMagicLink(actorBrowser, 'actor@test.com', {
      subjectData: { adminApproved: true }
    });
    const aliceBrowser = new Browser();
    const { accessToken: delegatedToken } = await testLoginWithMagicLink(aliceBrowser, 'alice@test.com', {
      subjectData: { adminApproved: true },
      actorAccessToken: actorToken  // actor's access token for delegation
    });

    expect(accessToken).toBeDefined();
    expect(sub).toBeDefined();
    expect(adminToken).toBeDefined();
    expect(delegatedToken).toBeDefined();

    // Verify delegation claim
    const claims = parseJwtUnsafe(delegatedToken).payload as any;
    expect(claims.act).toBeDefined();
  }, { timeout: 15000 });

  // Matches testing.mdx:395 — Delegation test flow with actor authorization
  it('delegation test flow with authorization', async () => {
    const fetch = (url: string, init?: RequestInit) => new Browser().fetch(`https://localhost${url}`, init);

    // Pre-setup: create alice to get her sub (targetSub)
    const setupBrowser = new Browser();
    const { sub: targetSub } = await testLoginWithMagicLink(setupBrowser, 'alice@test.com', {
      subjectData: { adminApproved: true }
    });

    // --- Doc code from testing.mdx:395 ---

    const adminBrowser = new Browser();
    const { accessToken: adminToken } = await testLoginWithMagicLink(adminBrowser, 'admin@test.com', {
      subjectData: { isAdmin: true }
    });

    // Login the actor
    const actorBrowser = new Browser();
    const { accessToken: actorToken, sub: actorSub } = await testLoginWithMagicLink(
      actorBrowser, 'actor@test.com', { subjectData: { adminApproved: true } }
    );

    // Authorize actorSub to act on behalf of targetSub
    await fetch(`/auth/subject/${targetSub}/actors`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ actorSub })
    });

    // Login alice with delegation — actor acts on her behalf
    const aliceBrowser = new Browser();
    const { accessToken, sub } = await testLoginWithMagicLink(aliceBrowser, 'alice@test.com', {
      subjectData: { adminApproved: true },
      actorAccessToken: actorToken  // actor's access token for delegation
    });

    // --- End doc code ---

    expect(accessToken).toBeDefined();
    expect(sub).toBe(targetSub);

    // Verify: sub = alice's sub, parseJwtUnsafe(accessToken).payload.act.sub = actorSub
    const claims = parseJwtUnsafe(accessToken).payload as any;
    expect(claims.act.sub).toBe(actorSub);
  }, { timeout: 15000 });
});
