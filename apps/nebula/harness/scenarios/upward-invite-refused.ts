/**
 * **A real star-scoped admin is refused `/invite` above their own scope — the escalation the
 * route-guard pipeline must never ship.**
 *
 * The Registry's edge guard used to be downward-shaped containment, which refused upward for free;
 * the pipeline's `passageGuard` admits upward *by design*, so the only thing refusing an upward
 * invite is `dominionOverScopeGuard`. A swap that landed passage without the dominion guard would
 * let a Star `scopeAdmin` POST `/auth/{u}/invite` and mint identities at the Universe.
 *
 * ⚠️ **Real login throughout (ADR-009 rung 1), and that is the point.** `provisionStarAdmin` claims
 * the Star through the open self-signup path, so the caller's `authScope` is the Star itself —
 * decided by the server, with no fixture that could have been built in the shape that passes
 * either way. This is the fixture-free form of the in-lane upward-refusal test
 * (`packages/nebula-auth/test/route-guards.test.ts`).
 *
 * Three limbs, each with its own assertion:
 *  1. **Positive control** — the same admin, same token, invites at their OWN Star: 200. Without
 *     this, the refusals below would also be satisfied by a broken route or a dead token.
 *  2. **One level up** (`/auth/{u}.{g}/invite`): 403, and the MESSAGE is the dominion refusal.
 *  3. **Two levels up** (`/auth/{u}/invite`): same.
 *
 * ⚠️ Limbs 2–3 match the dominion MESSAGE (`does not administer`), never a bare status: a boundary
 * refusal, a passage refusal, and a dominion refusal are indistinguishable as booleans, and the
 * collapse of those is exactly what this scenario exists to catch. `insufficient_scope` (not
 * `forbidden`) is likewise load-bearing: the caller HOLDS `scopeAdmin`, so the rule that fails is
 * dominion over the addressed scope.
 *
 * `needsContainer = false` — auth routes only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
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

  const invite = (target: string) => fetch(`${origin}/auth/${target}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${starAdmin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [uniqueTestEmail()] }),
  });

  // ── LIMB 1: positive control — the admin's OWN Star accepts the invite ────────────────────────
  // (Sends one real email into the catch-all; nothing waits on it, so no waiter can leak.)
  const own = await invite(star);
  assert.equal(
    own.status, 200,
    `a star-scoped admin was refused /invite at their OWN Star (${own.status}) — the refusals ` +
    'below would be vacuous (broken route or dead token, not direction)',
  );

  // ── LIMBS 2–3: one and two levels up — refused by DOMINION, with the dominion message ─────────
  for (const target of [galaxy, universe]) {
    const resp = await invite(target);
    assert.equal(
      resp.status, 403,
      `a star-scoped admin was NOT refused /invite at "${target}" (${resp.status}) — upward ` +
      'dominion is nil (ADR-015), and this is the escalation the guard exists to stop',
    );
    const body = await resp.json() as { error: string; error_description: string };
    assert.equal(
      body.error, 'insufficient_scope',
      `the upward refusal at "${target}" carried "${body.error}" — the caller holds scopeAdmin, ` +
      'so the failing rule is dominion over the addressed scope, named insufficient_scope',
    );
    assert.equal(
      body.error_description, `Token scope "${star}" does not administer "${target}"`,
      `the refusal message at "${target}" was not the DOMINION message — a boundary or passage ` +
      `refusal satisfies a bare 403, which is the collapse this limb catches. Got: ${body.error_description}`,
    );
  }

  console.error(
    '[upward-invite-refused] own-scope invite succeeded; one- and two-level upward invites ' +
    'refused by dominion with the dominion message',
  );
}
