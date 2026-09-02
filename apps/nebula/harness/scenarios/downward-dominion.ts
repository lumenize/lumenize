/**
 * **Downward dominion is total, and it is the DOMINION that grants — not an open scope.**
 *
 * A **universe** admin, obtained by a REAL email login (`provisionAndLogin`, ADR-009 rung 1), acts
 * on a Galaxy beneath itself where it holds **no DAG grant at all**, and the write COMMITS — via
 * the scope-admin bypass in `DagTree.requirePermission`. A non-admin at that same Galaxy is DENIED
 * the identical op, which is what proves the first result is the bypass rather than an ungated
 * scope. (Pre-collapse this drove a `.dev` Star; the collapse re-homed the harness's resource
 * plane onto the Galaxy chat host, and the subject — the bypass — is host-agnostic.)
 *
 * ⚠️ **Re-derived, not ported, and the reason is the whole argument for this tier.** The earlier
 * version of this scenario drove `connectDriver`'s **mint** path with `issuerInstanceName:
 * 'nebula-platform'`, and its own JSDoc had to record the consequence: *you could not produce a
 * denial by narrowing through this harness*, because the mint set the issuing instance from the
 * scope, so narrowing the scope narrowed the claim in lockstep and it still covered the callee.
 * That is a harness whose construction diverges from what the server issues — every assertion riding
 * it was about a shape production could not mint. Under `access.authScope` the lockstep dissolves
 * (the claim IS the scope), so the admin limb is now a real login and the server decides the claim.
 *
 * ⚠️ **The admin's dominion here is genuinely non-trivial, unlike the old `'*'` principal.** Its
 * `authScope` is the UNIVERSE and the callee is the Galaxy below, so `isAtOrAbove` has to do
 * real work — where the platform root returned `true` without reading its second argument at all.
 * A covering admin at a real tier is therefore the stronger observer, not a weaker one.
 *
 * ⚠️ **The admin holds no DAG grant at TARGET, and that is load-bearing.** Post-collapse the host
 * is the GALAXY chat plane, which has no root-admin seed at all (`Star.onBeforeCall`'s seed is
 * Star-only and exact-identity besides), so the admin's commit can come from nothing but the
 * confined scope-admin bypass. The control limb is what keeps it honest: the identical op denied
 * proves the first result is the bypass rather than an ungated scope.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { acceptInviteAndLogin, refreshAccessToken } from '../../test/lib/email-login';

/** Resource ops on the Galaxy chat host only — never a build, so the boot skips Docker. */
export const needsContainer = false;

/** A galaxy neither identity founded or holds a grant on (the collapse's chat/resource host). */
const TARGET = 'claude-reach.sandbox';

export async function run(stack: DevStack): Promise<void> {
  // REAL LOGIN (rung 1) — `provisionAndLogin` claims the universe, logs in there for real, then
  // creates the galaxy beneath with that admin's own token and re-issues at TARGET. The
  // resulting claim is the server's: `authScope` = the universe, `aud` = TARGET, `scopeAdmin` set.
  // No mint, no `reason`, nothing hand-built for the assertion to be wrong about.
  const admin = await connectDriver(stack, { scope: TARGET });

  // The control — a NON-admin at TARGET, enrolled the only way production enrols one: the admin
  // invites them through the ONE production surface, the real email arrives, the click is a real
  // consume, acceptance is a real consent, the token is a real refresh. Nothing here is built for
  // the assertion to be wrong about. (Until 2026-09-02 this was a rung-3 mint that "isolated the
  // bypass without a second email loop" — a fixture that happened to be a function, and the loop
  // it saved costs about a second.)
  const controlEmail = uniqueTestEmail();
  const testToken = readDevVar('TEST_TOKEN');
  // Arm the waiter BEFORE the invite; the facade tags invite mail with the target scope.
  const waiter = waitForEmail({ testToken, instance: TARGET, to: controlEmail, timeout: 60_000 });
  let inviteLink: string;
  try {
    const summary = await admin.client.invite(TARGET, [{ email: controlEmail }]);
    assert.equal(summary.errors.length, 0, `invite refused: ${JSON.stringify(summary.errors)}`);
    const mail = await waiter.emailPromise;
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(mail.html ?? '')?.[1];
    assert.ok(href, 'invite email carried no accept-invite link');
    inviteLink = href.replace(/&amp;/g, '&'); // followed AS SENT — it names this stack's origin
  } finally {
    waiter.cleanup();
  }
  const { refreshToken } = await acceptInviteAndLogin({ baseUrl: stack.baseUrl, inviteLink, scope: TARGET });
  const member = await refreshAccessToken(stack.baseUrl, { refreshToken, authScope: TARGET }, TARGET);
  const control = await connectDriver(stack, { scope: TARGET, session: member });

  try {
    // Both limbs run the IDENTICAL op — a `Chat` create off the installed chat ontology — so a
    // divergent outcome can only be the permission decision, never the shape.
    const adminOut = await admin.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Chat',
        nodeId: ROOT_NODE_ID,
        value: { title: 'covering-admin dominion' },
      },
    });
    assert.equal(
      adminOut.kind,
      'committed',
      `a covering universe admin should act on an ungranted Galaxy beneath it via the ` +
      `access.scopeAdmin bypass, got kind=${adminOut.kind}`,
    );

    const controlOut = await control.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Chat',
        nodeId: ROOT_NODE_ID,
        value: { title: 'should be denied' },
      },
    });
    assert.equal(
      controlOut.kind,
      'rejected',
      `a non-admin must be denied on an ungranted scope (this is what proves the admin's success ` +
      `is the dominion bypass, not an open scope), got kind=${controlOut.kind}`,
    );
  } finally {
    admin.wipe();
    admin.dispose();
    control.dispose();
  }
}
