/**
 * **A Profile never runs under a scope's name, and every real profile id still reaches its Profile.**
 *
 * Passage reads a claimless chain's `activeScope` from the name of the node that started it, which
 * is sound only if every object under a scope-shaped name checks passage into that scope. A
 * Profile checks none, so its base, `UnscopedMeshDO`, refuses to run under a name that parses as a
 * scope. Every profile id passes: a UUID, a persona's version-5 UUID, and `NEBULA_SUB`, which is no
 * UUID at all.
 *
 * The other half of that passage rule, a chain a node started, has no product path that a tab can
 * drive to a sibling, so `apps/nebula/test/test-apps/baseline/node-chain-passage.test.ts` covers
 * it in-lane. Every subscription push's fire-back runs on a chain its Star started, so every
 * subscription scenario covers that rule's admission once a push is answered at the fire-back door.
 *
 * Two limbs, both run, with the verdict at the end (`live-scenarios.md`):
 *  1. **A tab calling `PROFILE` at a Star's name is refused with `UnscopedMeshDO`'s message.**
 *     Mutation: drop the check from `lmz.__init`, and the call is admitted.
 *  2. **Positive control: a tab subscribing to the `NEBULA_SUB` Profile receives its snapshot.**
 *     Mutation: refuse every name that is not a UUID, and the subscribe is refused.
 *
 * A real login throughout (ADR-009 rung 1): the run's shared app's owner, signed in by email.
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

const PROFILE_REFUSAL = /parses as a scope, and an UnscopedMeshDO never runs under a scope's name/;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const session = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  const tab = await connectDriver(stack, { scope: app.galaxy, session: { accessToken: session.accessToken, sub: session.sub } });
  const failures: string[] = [];
  try {
    // ── LIMB 1: a Profile refuses to run under a Star's name ────────────────────────────────────
    const starName = `${app.galaxy}.${testSlug('np')}`;
    let refused: string | null;
    try {
      await tab.client.lmz.callAsync('PROFILE', starName, (tab.client.ctn() as any).subscribe());
      refused = null;
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    if (refused !== null && PROFILE_REFUSAL.test(refused) && refused.startsWith(`"${starName}"`)) {
      console.log('  ✓ limb 1 — a Profile refuses to run under a Star\'s name');
    } else {
      console.log(`  ✗ limb 1 — got ${refused ?? '(admitted)'}`);
      failures.push(`limb 1: a call to PROFILE at ${starName} was not refused by the Profile. Got: ${refused ?? '(admitted)'}`);
    }

    // ── LIMB 2: positive control — the NEBULA_SUB Profile, whose id is no UUID, still answers ───
    using nebulaProfile = tab.client.subscribeProfile(NEBULA_SUB);
    let name: string | undefined;
    let error: string | undefined;
    try {
      const snap = await nebulaProfile.snapshot as { value?: { name?: string } } | null;
      name = snap?.value?.name;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (name === 'Lumenize') {
      console.log('  ✓ limb 2 — the NEBULA_SUB Profile answers a subscribe with its seeded snapshot');
    } else {
      console.log(`  ✗ limb 2 — got ${error ?? name ?? '(no snapshot)'}`);
      failures.push(`limb 2: subscribing to ${NEBULA_SUB} did not deliver its snapshot. Got: ${error ?? name ?? '(no snapshot)'}`);
    }
  } finally {
    tab.dispose();
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
