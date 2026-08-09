/**
 * Profile-store — the `profileId` mint (a column on the ADDRESS row) and the
 * bare custom `profileId` JWT claim, threaded through all THREE KV-record writers so the claim
 * survives the pure-KV refresh mint. Every test is capable-of-failing: gutting the code under test
 * reddens it. tasks/nebula-profile-store.md Phase 1.
 *
 * Grounding: rung 2 (test-mode issuance) through the real Worker → registry → KV → JWT-mint paths
 * (ADR-009) — the same vehicle as identity-mint-point.test.ts. `foundUniverse`/`inviteAndLogin` mint
 * real identities; `refreshAndParse` returns the parsed minted JWT so we assert the claim end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hashString, parseJwtUnsafe } from '@lumenize/crypto';
import {
  foundUniverse, inviteAndLogin, refreshAndParse, requestMagicLink, clickLink, adminRequest,
} from './test-helpers';

/** The ADR-016 acting-principal argument these registry methods now require. Recorded, never
 *  consulted — authorization keys off the caller's own verified access, not off this. */
const ACTING = (sub = crypto.randomUUID()) => ({ sub, access: { authScopePattern: '*', scopeAdmin: true } }) as any;

function uniqueUniverse(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Phase 1 — profileId mint (one INSERT; a UUID distinct from sub; idempotent)', () => {
  it('claim-universe mints a profileId on the address row AND emits it as a JWT claim (rung-2 login)', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    // The minted JWT carries a bare `profileId` claim (a UUID)...
    expect(admin.parsed.profileId).toMatch(UUID_RE);
    // ...distinct from the surrogate `sub` (deliberately separate namespaces — the public address).
    expect(admin.parsed.profileId).not.toBe(admin.parsed.sub);
    // ...and it reflects the AUTHORITATIVE Emails.profileId, not a random per-mint value.
    const scope = await getRegistry().getIdentityScope(admin.parsed.sub);
    expect(scope.profileId).toBe(admin.parsed.profileId);
  });

  it('a returning login (find-and-flip, no re-mint) keeps the SAME profileId', async () => {
    const uni = uniqueUniverse();
    const first = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    // Log in again via a fresh login magic link → same sub AND same profileId (the INSERT is not re-run).
    const mlResp = await requestMagicLink(SELF, uni, 'scope-admin@example.com');
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };
    const { refreshToken } = await clickLink(SELF, magicLinkUrl);
    const second = await refreshAndParse(SELF, uni, refreshToken);

    expect(second.parsed.sub).toBe(first.parsed.sub);
    expect(second.parsed.profileId).toBe(first.parsed.profileId); // reds if a login re-mints profileId
  });

  /**
   * ⚠️ **Two different PEOPLE, which is the only thing this asserts.** It says nothing about whether
   * one person's addresses share a `profileId` — and must not, because the direction there is
   * changing: `profileId` becomes a property of the ADDRESS, so one address in several scopes
   * resolves to one `profileId`. The earlier title ("1 sub : 1 profile") and comment ("a per-identity
   * `profileId`, not shared") described the model being reversed, and this test stays green through
   * that reversal because it uses two *distinct* addresses — so its prose, not its assertion, was the
   * thing a future reader would have taken as settled intent.
   */
  it('two different PEOPLE get distinct profileIds', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const member = await inviteAndLogin(SELF, uni, admin.access_token, 'member@example.com');

    expect(member.parsed.profileId).toMatch(UUID_RE);
    expect(member.parsed.profileId).not.toBe(admin.parsed.profileId);
  });
});

describe('Phase 1 — profileId rides all THREE KV-record writers → the claim survives refresh', () => {
  it('(a) the login record writer (#recordRefreshToken) puts profileId in the KV record', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    const rec = await kvRecord(admin.refreshToken);
    expect(rec.profileId).toBe(admin.parsed.profileId); // reds if #recordRefreshToken drops profileId
  });

  it('(b) the setIdentityAdmin convergence re-put carries profileId forward → next refresh still has the claim', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const profileId = admin.parsed.profileId;

    // Toggle the admin bit → the convergence re-put REBUILDS the KV record (distinct from the (c) miss path).
    await getRegistry().setIdentityAdmin(admin.parsed.sub, false, ACTING());

    // The rebuilt record must still carry profileId (reds if the re-put drops it — as it must re-apply expiry).
    expect((await kvRecord(admin.refreshToken)).profileId).toBe(profileId);
    // And the next refresh still emits the claim...
    const refreshed = await refreshAndParse(SELF, uni, admin.refreshToken);
    expect(refreshed.parsed.profileId).toBe(profileId);
    // ...while the admin bit genuinely converged (positive control the re-put actually ran).
    expect(refreshed.parsed.access.scopeAdmin).toBeUndefined();
  });

  it('(c) a FORCED KV-miss self-heal reconstructs the record WITH profileId → the minted JWT keeps the claim', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const profileId = admin.parsed.profileId;

    // FORCE the miss: miniflare KV is strongly consistent, so a normal refresh HITS KV and never
    // exercises the (c) self-heal. Delete ONLY the KV record (RefreshTokenIndex + membership stay live).
    await (env as any).REFRESH_TOKEN_KV.delete(`refresh:${await hashString(admin.refreshToken)}`);
    expect(await kvRecord(admin.refreshToken)).toBeNull();

    // The self-heal (getRefreshRecord → getIdentityScope) must reconstruct WITH profileId → claim present.
    const refreshed = await refreshAndParse(SELF, uni, admin.refreshToken);
    expect(refreshed.parsed.profileId).toBe(profileId); // reds if getIdentityScope/getRefreshRecord drops it
    // ...and self-heal the KV record so subsequent direct-KV refreshes also carry it.
    expect((await kvRecord(admin.refreshToken)).profileId).toBe(profileId);
  });
});

describe('Phase 1 — a narrower token carries the SUBJECT profileId (getIdentityScope path)', () => {
  it('a narrower token carries the SUBJECT identity profileId, never the caller', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'admin@example.com');
    const user = await inviteAndLogin(SELF, uni, admin.access_token, 'user@example.com');

    const resp = await adminRequest(SELF, uni, 'mint-narrower-token', admin.access_token, {
      method: 'POST', body: { subOfNarrowerToken: user.parsed.sub, activeScope: uni },
    });
    expect(resp.status).toBe(200);
    const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;

    expect(parsed.profileId).toBe(user.parsed.profileId);        // the SUBJECT's profile (the token acts AS them)
    expect(parsed.profileId).not.toBe(admin.parsed.profileId);   // NOT the caller's — reds if the wrong sub is used
  });
});
