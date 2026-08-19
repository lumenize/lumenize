/**
 * **A real star-scoped admin is refused an invite above their own scope — the escalation the
 * facade's eligibility rule must never ship.**
 *
 * Every invite enters mesh-side through `NebulaAuthFacade.invite` (there is no HTTP route), whose
 * rule is: exact-scope membership ∨ dominion over the target. A star admin inviting upward has
 * neither — their membership is AT the star and dominion flows strictly downward (ADR-015) — so
 * the forbidden shape is unrepresentable. A regression that widened eligibility (say, passage)
 * would let a Star `scopeAdmin` mint identities at the Universe.
 *
 * ⚠️ **Real login throughout (ADR-009 rung 1), and that is the point.** `provisionStarAdmin` claims
 * the Star through the open self-signup path, so the caller's `authScope` is the Star itself —
 * decided by the server, with no fixture that could have been built in the shape that passes
 * either way. This is the fixture-free form of the in-lane refusal tests
 * (`apps/nebula/test/test-apps/baseline/invite-facade.test.ts`).
 *
 * Three limbs, each with its own assertion:
 *  1. **Positive control** — the same admin, same client, invites at their OWN Star: a summary
 *     with an `invited` outcome. Without this, the refusals below would also be satisfied by a
 *     broken binding or a dead token.
 *  2. **One level up** (the galaxy): rejected, and the MESSAGE is the facade's dominion refusal.
 *  3. **Two levels up** (the universe): same.
 *
 * ⚠️ Limbs 2–3 match the MESSAGE (`does not administer`), never a bare rejection: a claims-less
 * refusal, a membership refusal, and a dominion refusal are indistinguishable as booleans, and the
 * collapse of those is exactly what this scenario exists to catch. The `does not administer` form
 * is likewise load-bearing: the caller HOLDS `scopeAdmin`, so the rule that fails is dominion over
 * the addressed scope — the non-admin wording (`is not a membership at …`) would misname it.
 *
 * `needsContainer = false` — auth only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionStarAdmin } from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `uir-${suffix}`;
  const galaxy = `${universe}.app`;
  const star = `${galaxy}.tenant`;

  // A real Star founder: `claim-star` self-signup mints them admin AT the Star, so the server puts
  // exactly that Star in their `authScope` (`provisionStarAdmin` founds the universe + galaxy above
  // as a different `owner-…` identity).
  const starAdmin = await provisionStarAdmin({
    baseUrl: origin, scope: star, email: uniqueTestEmail(), testToken,
  });
  let driver: Driver | undefined;
  try {
    driver = await connectDriver(stack, {
      scope: star,
      session: { accessToken: starAdmin.accessToken, sub: starAdmin.sub },
    });

    // ── LIMB 1: positive control — the admin's OWN Star accepts the invite ──────────────────────
    // (Sends one real email into the catch-all; nothing waits on it, so no waiter can leak.)
    const own = await driver.client.invite(star, [{ email: uniqueTestEmail() }]);
    assert.equal(
      own.errors.length, 0,
      `a star-scoped admin was refused an invite at their OWN Star (${JSON.stringify(own.errors)}) — ` +
      'the refusals below would be vacuous (broken binding or dead token, not direction)',
    );
    assert.equal(own.results[0]?.outcome, 'invited', 'the own-scope invite must mint');

    // ── LIMBS 2–3: one and two levels up — rejected by the facade's DOMINION message ────────────
    for (const target of [galaxy, universe]) {
      let message = '';
      try {
        await driver.client.invite(target, [{ email: uniqueTestEmail() }]);
        assert.fail(
          `a star-scoped admin was NOT refused an invite at "${target}" — upward dominion is nil ` +
          '(ADR-015), and this is the escalation the facade rule exists to stop',
        );
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        message = err instanceof Error ? err.message : String(err);
      }
      assert.equal(
        message, `Token scope "${star}" does not administer "${target}"`,
        `the refusal at "${target}" was not the DOMINION message — a claims-less or membership ` +
        'refusal satisfies a bare rejection, which is the collapse this limb catches',
      );
    }
  } finally {
    driver?.dispose();
  }

  console.error(
    '[upward-invite-refused] own-scope invite minted; one- and two-level upward invites ' +
    'rejected by the facade with the dominion message',
  );
}
