/**
 * **A token acts from the host it was minted for: dominion runs down from that host, passage up
 * from it, and the membership behind it decides neither.**
 *
 * The cast: **O** owns the account `{u}` and its app `{u}.crm`, with two tenant Stars, `t1` and `t2`.
 * O's one universe cookie mints on every page beneath `{u}`, so every token below is O's, from a
 * real login, and only its `aud` differs.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **From a tenant's page, dominion stops at the tenant.** O's token from `t1` is refused a
 *     dominion-gated call on the sibling `t2` (passage), on the galaxy and on the universe
 *     (dominion), each matched by its message naming `t1`. *Reds if the checks read `authScope`
 *     again — all three pass.*
 *  2. **From the universe's page, the same membership holds all three.** The positive control.
 *  3. **The facade refuses below the target's parent.** From the `.dev` Star's page, O's deletion of
 *     the galaxy and creation of a second app are refused with the facade's own messages, naming
 *     the `.dev` Star. *Reds if the facade's pre-check is skipped — the Registry's message arrives
 *     instead — or reads `authScope` — the calls succeed.*
 *  4. **A tenant page cannot invite into the galaxy above it.** The refusal names the tenant's
 *     scope. *Reds if the facade's eligibility reads `authScope`.*
 *
 * `needsContainer = false` — auth, the facade and the tier Durable Objects only.
 */
import assert from 'node:assert/strict';
import type { Galaxy, Star, Universe } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin, foundTenantStar, refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl;
  const universe = `hr${crypto.randomUUID().slice(0, 8)}`;
  const galaxy = `${universe}.crm`;
  const [t1, t2, dev] = [`${galaxy}.t1`, `${galaxy}.t2`, `${galaxy}.dev`];

  const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
  for (const star of [t1, t2]) {
    assert.ok(await foundTenantStar({ baseUrl: origin, star, testToken }), `${star} could not be founded`);
  }
  /** O's driver on `page`'s host, from O's one universe cookie. */
  const on = async (page: string) => connectDriver(stack, { scope: page, session: await refreshAccessToken(origin, owner.session, page) });
  const outcome = async (p: Promise<unknown>) => { try { await p; return '(admitted)'; } catch (e) { return (e as Error).message; } };
  const authScope = owner.session.authScope;
  assert.equal(authScope, universe, "fixture guard: O's cookie is the universe membership");

  // ── LIMB 1: from a tenant's page, dominion stops at the tenant ─────────────────────────────
  const fromT1 = await on(t1);
  try {
    const c = fromT1.client;
    assert.equal(await outcome(c.lmz.callAsync('STAR', t2, c.ctn<Star>().setStarConfig('host-rule', 1))),
      `No passage from "${t1}" into "${t2}"`, 'a tenant page must have no passage into its sibling');
    const dominion = (node: string) =>
      `Admin access required for ${node} — the calling host's scope is ${t1}, and the token rests on the membership at ${universe}`;
    assert.equal(await outcome(c.lmz.callAsync('GALAXY', galaxy, c.ctn<Galaxy>().setGalaxyConfig('host-rule', 1))),
      dominion(galaxy), 'a tenant page must hold no dominion over the galaxy');
    assert.equal(await outcome(c.lmz.callAsync('UNIVERSE', universe, c.ctn<Universe>().setUniverseConfig('host-rule', 1))),
      dominion(universe), 'a tenant page must hold no dominion over the universe');
    console.error("  ✓ limb 1 — from t1's page, t2 was refused by passage and the galaxy and universe by dominion");

    // ── LIMB 4: a tenant page cannot invite into the galaxy above it ─────────────────────────
    assert.equal(await outcome(c.invite(galaxy, [{ email: `invitee-${universe}@lumenize-test.dev` }])),
      `Inviting into "${galaxy}" needs dominion over it, and the calling host's scope is "${t1}"`,
      "a tenant page's invite into the galaxy must be refused naming the tenant");
    console.error("  ✓ limb 4 — t1's page could not invite into the galaxy, by a message naming t1");
  } finally {
    fromT1.dispose();
  }

  // ── LIMB 2: from the universe's page, the same membership holds all three ─────────────────
  const fromU = await on(universe);
  try {
    const c = fromU.client;
    assert.equal(await outcome(c.lmz.callAsync('STAR', t2, c.ctn<Star>().setStarConfig('host-rule', 1))), '(admitted)');
    assert.equal(await outcome(c.lmz.callAsync('GALAXY', galaxy, c.ctn<Galaxy>().setGalaxyConfig('host-rule', 1))), '(admitted)');
    assert.equal(await outcome(c.lmz.callAsync('UNIVERSE', universe, c.ctn<Universe>().setUniverseConfig('host-rule', 1))), '(admitted)');
    console.error("  ✓ limb 2 — the same membership from the universe's page held all three");
  } finally {
    fromU.dispose();
  }

  // ── LIMB 3: the facade refuses below the target's parent ──────────────────────────────────
  const fromDev = await on(dev);
  try {
    const c = fromDev.client;
    assert.equal(await outcome(c.scopes.delete(galaxy)),
      `Deleting "${galaxy}" needs dominion over it, and the calling host's scope is "${dev}"`,
      "the .dev page's deletion of its galaxy must be refused by the facade");
    assert.equal(await outcome(c.scopes.createGalaxy(universe, 'x')),
      `Creating an app in "${universe}" needs dominion over it, and the calling host's scope is "${dev}"`,
      "the .dev page's creation of an app must be refused by the facade");
    console.error("  ✓ limb 3 — from the .dev page, the facade refused the galaxy's deletion and a new app");
  } finally {
    fromDev.dispose();
  }
}
