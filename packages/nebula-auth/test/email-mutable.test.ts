/**
 * `email` is a mutable attribute (the surrogate `sub` is the identity key), so a re-point is a single
 * one-row update with no cascade / re-key / token re-issue, and `discover` stays `sub`-free.
 *
 * ⚠️ **SCOPE: this file tests the registry PRIMITIVE `changeEmail`, never the email-change FLOW.**
 * `changeEmail(sub, newEmail)` has no production caller — no route reaches it — and it deliberately
 * performs no authorization and no revocation: it updates one column. The flow that will eventually
 * call it is a different thing entirely, and it is **unbuilt**; its pinned contract is the skipped
 * block at the bottom of this file. Do NOT read a green test here as evidence that re-pointing an
 * address is safe to expose — implementing an endpoint that just calls `changeEmail` would ship the
 * escalation the flow's design exists to prevent (an admin re-pointing someone else's identity).
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import { foundUniverse, requestMagicLink, clickLink, refreshAndParse } from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('changeEmail — the registry primitive: a re-point is ONE row, not one of N', () => {
  it('a re-point is one row: same sub, new address resolves, old does not, and no token is re-keyed', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'old@example.com');
    const sub = admin.parsed.sub;
    const registry = getRegistry();

    // The sub's refresh token is anchored to `sub`, not email.
    expect((await kvRecord(admin.refreshToken)).sub).toBe(sub);

    // Change the email — a single-row update.
    expect(await registry.changeEmail(sub, 'new@example.com')).toBe(true);

    // discover: the NEW address resolves to the scope; the OLD no longer does.
    expect((await registry.discover('new@example.com')).map((d: any) => d.universeGalaxyStarId)).toEqual([u]);
    expect(await registry.discover('old@example.com')).toEqual([]);

    // The sub's refresh token is STILL valid — the KV record is sub-anchored, so a re-point re-keys
    // nothing. ⚠️ This is a fact about the PRIMITIVE, not a statement that surviving the change is the
    // desired end state: the flow revokes deliberately (see the skipped block below), and it does so
    // at the endpoint, never in here. Asserting survival here is what proves there is no hidden
    // email→token coupling; it is not an endorsement of leaving the session alive.
    const refreshed = await refreshAndParse(SELF, u, admin.refreshToken);
    expect(refreshed.parsed.sub).toBe(sub);

    // Logging in with the NEW address (find-and-flip) resolves to the SAME sub.
    const ml = await requestMagicLink(SELF, u, 'new@example.com');
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const { refreshToken } = await clickLink(SELF, magicLinkUrl);
    const viaNew = await refreshAndParse(SELF, u, refreshToken);
    expect(viaNew.parsed.sub).toBe(sub);

    // Logging in with the OLD address is rejected (no identity resolves there anymore).
    const oldMl = await requestMagicLink(SELF, u, 'old@example.com');
    const { magicLinkUrl: oldUrl } = await oldMl.json() as { magicLinkUrl: string };
    const oldClick = await SELF.fetch(new Request(oldUrl, { redirect: 'manual' }));
    expect(oldClick.headers.get('Set-Cookie')).toBeNull(); // rejected — old email no longer an identity
  });

  it('changeEmail returns false for an unknown sub', async () => {
    expect(await getRegistry().changeEmail('no-such-sub', 'x@example.com')).toBe(false);
  });

  it('discover is sub-FREE and reads the UNIQUE(email, scope) index', async () => {
    const u = uni();
    await foundUniverse(SELF, u, 'disc@example.com');
    const entries = await getRegistry().discover('disc@example.com');
    expect(entries).toEqual([{ universeGalaxyStarId: u, isAdmin: true }]);
    expect(entries[0]).not.toHaveProperty('sub');
  });
});

/**
 * The email-change FLOW — unbuilt. These carry its pinned contract so the design is not re-derived
 * from `changeEmail`'s signature, which encodes none of it.
 *
 * ⚠️ **Skipped because the entry point does not exist**, not because the behaviour is optional. The
 * arrange steps below are therefore written against a route that has yet to be chosen — that is the
 * one thing here that is a placeholder, and it is marked at each site.
 *
 * ⚠️ **Asserted = PINNED only.** Deliberately left unasserted, because the design has not settled
 * them and a guessed assertion is a scaffold that looks like coverage:
 *   - the endpoint's path, method, and request/response shapes;
 *   - how the two proofs are carried (a purpose-scoped magic link vs. its own table) and whether
 *     consuming the old-address proof mints a session — it must not, but the carrier is open;
 *   - WHICH identity resolves the target `emailId` — the refresh record's `sub` or the access token's
 *     `sub`. Under impersonation those name different people, so this is load-bearing and open.
 */
describe.skip('the email-change FLOW (unbuilt) — pinned contract', () => {
  it('a live session is NOT sufficient: the change requires fresh proof of the OLD address', async () => {
    // A session outlives mailbox control by up to the fixed 30-day refresh TTL, so authorising off the
    // current session hands a departing employee that whole window as an escape hatch. The proof must
    // be delivered to the old address AT CHANGE TIME.
    // ARRANGE (placeholder): an authenticated session for `sub`, no old-address proof presented.
    // ASSERT: the request is refused, and the row still resolves to the OLD address.
  });

  it('a request carrying an `act` chain is refused, and mails nothing', async () => {
    // Scope authority over an identity can be MANUFACTURED (claim a Universe, invite any address),
    // and a narrower token's top-level `sub` IS the victim — so without this predicate an attacker
    // makes Nebula send a legitimate confirm link to the victim's real mailbox. Presence-only: it
    // tests that `act` is present, never who the actor is.
    //
    // 🔒 **WHOEVER BUILDS THIS OWES THE PREDICATE A COMMENT AT THE SITE — treat that as part of the
    // acceptance, not a nicety.** This clause has been re-argued at least a dozen times and reversed
    // twice, because it *looks* like a violation of the read-side rule it is actually a licensed
    // exception to: authz never reads `act`, and here authz reads `act`. Every fresh reader therefore
    // arrives wanting to "simplify" it away, and nothing else in the request path weakens visibly when
    // they do. The comment must carry (a) that it is presence-only and MUST NOT become
    // `act.sub === claims.sub`, which reads the chain's identity and is the manufacture it defends
    // against; (b) that it is what makes the target-`emailId` question moot, so removing it reopens a
    // decision rather than just a check. `profile.ts`'s owner branch already carries exactly this kind
    // of comment for the same predicate on a different surface — copy its shape, not its wording.
    //
    // ARRANGE (placeholder): a narrower token minted for `sub`, POSTed to the change endpoint.
    // ASSERT: refused; no email is sent (assert on the email sender, not on a response body).
  });

  it('the request starves ONLY the session it arrived on, identified by token HASH', async () => {
    // Not by `sub`: a `sub` is per-(email, scope), and an impersonated token carries the victim's
    // `sub`, so revoking by `sub` would let one session-kill reach every scope that address touches.
    // ARRANGE (placeholder): two live sessions for `sub`; the change request carries session A's
    // refresh cookie.
    // ASSERT: A's refresh record is gone; B's survives.
  });

  it('consuming the old-address proof revokes every `sub` anchored to that `emailId`', async () => {
    // Triggered by possession of the mailbox, which no token can fake — which is why the broad,
    // cross-scope revoke hangs off the proof rather than off the request.
    // ARRANGE (placeholder): memberships in two scopes for one address, sessions in both.
    // ASSERT: after the proof is consumed, neither session refreshes.
  });
});
