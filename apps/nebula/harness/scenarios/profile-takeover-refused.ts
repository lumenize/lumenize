/**
 * The manufacture attack, end to end, with **no fixture anywhere** — the security property this whole
 * identity split turns on.
 *
 * Universe self-signup is open by design and an invite mints the membership immediately, so anyone can
 * claim a Universe, invite an address they merely GUESSED, and thereby become "an admin of a scope
 * that stranger's profile touches". A profile is a *global* object, so if that were enough, the
 * Profile DO's scoped-admin branch would hand out write on anyone's public fields and read/write on
 * their private ones. What stops it is that only an **accepted** membership counts (ADR-012).
 *
 * **The same manufactured membership is refused at TWO doors, and both are driven here.** The Profile
 * DO's scoped-admin branch counts only accepted memberships (`getScopesForProfile`), and the narrower
 * mint resolves its subject through a read that answers only for accepted ones — so the attacker
 * cannot reach the profile as themselves, and cannot mint a token that would arrive as the victim.
 * The two rest on separate predicates in two registry methods, behind doors in different files, so a
 * mutation reddens one limb and not the other; that is what lets each be checked on its own.
 *
 * This drives the whole chain against a running server: two real email logins, a real invite, a real
 * client with a real token, the profile reached through the real Gateway, and the mint reached
 * through the production client capability, `impersonate()`.
 *
 * ⚠️ **Why this exists when two in-lane tests already cover it.** They cover it on **stacked
 * fixtures** — `profile-do.test.ts` hand-`INSERT`s the registry rows (`seedIdentity`) *and* mints a
 * synthetic token (`createNebulaTestToken`, ADR-009 rung 3), while `identity-mint-point.test.ts`
 * asserts at the registry level rather than on the refusal a caller actually receives. Neither proves
 * an attacker is refused; they prove a hand-built approximation of one is.
 *
 * ⚠️ **Keep both — NEITHER arm is a superset, so a future cleanup must not pick one.** This arm has no
 * fixture to build wrong, and proves the refusal a real caller receives. The in-lane pair runs in CI
 * with **no email infrastructure**, and reaches branches a real client cannot construct at all — the
 * fail-closed path and the registry-read counter need state a genuine login never produces. Delete
 * either and the coverage that survives is the one that happens to be cheaper, not the one that
 * happens to be right. This build twice shipped a seeded fixture in the
 * *safe* shape (a mutation-restore that corrupted a neighbour, and an acceptance fixture where the
 * guard held either way), which is exactly the failure a fixture-free scenario cannot have.
 *
 * ⚠️ **The second half is not decoration.** Asserting only the refusal would stay green against a gate
 * that refuses EVERYONE — including the legitimate co-scope admin the branch exists to serve. The
 * accept-then-permit half is what makes the refusal mean "unaccepted", not "broken".
 *
 * `needsContainer = false` — auth and profile only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Profile } from '@lumenize/nebula-auth/profile';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin, acceptInviteAndLogin } from '../../test/lib/email-login';
import { ImpersonationMintError } from '../../src/impersonation';

export const needsContainer = false;

/** True if the remote `@mesh` call was REFUSED (its promise rejected), false if it succeeded. */
async function refused(op: Promise<unknown>): Promise<boolean> {
  try { await op; return false; } catch { return true; }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);

  const victimEmail = uniqueTestEmail();
  const victimUniverse = `victim-${suffix}`;
  const evilUniverse = `evil-${suffix}`;

  // ── The victim: a real person with a real profile, in their OWN universe ─────────────────────
  const victim = await provisionAndLogin({
    baseUrl: origin, scope: victimUniverse, email: victimEmail, testToken,
  });
  const victimProfileId = (parseJwtUnsafe(victim.accessToken)!.payload as any).profileId as string;
  assert.ok(victimProfileId, 'the victim login carried no profileId claim');

  // ── The attacker: claims a Universe of their own. Open self-signup, no approval, real login ──
  const attacker = await connectDriver(stack, { scope: evilUniverse, email: uniqueTestEmail() });
  const writeVictim = () => attacker.client.lmz.callAsync(
    'PROFILE', victimProfileId, attacker.client.ctn<Profile>().writeProfile({ name: 'pwned' }),
  );
  const readVictimNotes = () => attacker.client.lmz.callAsync(
    'PROFILE', victimProfileId, attacker.client.ctn<Profile>().readPrivateNotes(),
  );

  try {
    // ── Manufacture the authority: invite an address you merely guessed ──────────────────────
    const waiter = waitForEmail({ testToken, instance: evilUniverse, to: victimEmail, timeout: 60_000 });
    let inviteLink: string;
    // The `sub` the invite MINTED — the victim's membership in the attacker's universe.
    // ⚠️ NOT the victim's own `sub` from `provisionAndLogin`: that one names their membership in
    // THEIR universe, which the attacker does not administer, so a mint on it would be refused for
    // want of dominion and the limb below would pass while proving nothing.
    let victimSubHere: string;
    try {
      // The ONE production surface — the attacker's own connected client (there is no HTTP route).
      const summary = await attacker.client.invite(evilUniverse, [{ email: victimEmail }]);
      assert.equal(summary.errors.length, 0, `invite failed: ${JSON.stringify(summary.errors)}`);
      victimSubHere = summary.results[0]?.sub as string;
      assert.ok(victimSubHere, 'the invite returned no sub for the invitee');
      // `extractMagicLink` is magic-link-specific by design; an invite is `accept-invite?invite_token=`,
      // and the `&amp;` in an email body must be unescaped or the link 404s.
      const html = (await waiter.emailPromise).html ?? '';
      const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
      assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
      inviteLink = href.replace(/&amp;/g, '&');
    } finally {
      waiter.cleanup();   // a leaked waiter's WebSocket hangs the process AFTER the verdict prints
    }

    // ── THE PROPERTY: manufactured authority buys nothing ────────────────────────────────────
    // The attacker now administers a scope the victim's profile touches — on paper. The membership
    // was never taken up, so it confers nothing. Reds if `getScopesForProfile` drops its acceptance
    // predicate, or swaps it for the address's `emailVerified` (which is already 1 here, because the
    // victim proved this mailbox founding their own Universe — that swap is the subtle one).
    assert.ok(await refused(writeVictim()), 'an UNACCEPTED invite let a stranger WRITE the victim profile');
    assert.ok(await refused(readVictimNotes()), 'an UNACCEPTED invite let a stranger READ private fields');

    // ── The same manufactured membership, at the MINT ────────────────────────────────────────
    // The attacker administers `evilUniverse` and this membership is IN `evilUniverse`, so dominion
    // holds — which is what makes the refusal below mean *the membership was never taken up*. The
    // 403 is the mint's COLLAPSED refusal and says none of the three reasons out loud, deliberately.
    // Each conjunct below buys something different: `ImpersonationMintError` excludes the client
    // pre-flight (which throws `ImpersonationChainError`) and a transport failure (a TypeError); the
    // message regex tells the collapsed refusal apart from the route's OTHER 403s, the aud
    // validation and the root-identity gate; and the FIXTURE picks which of the collapse's three
    // readings applies. The accept-then-permit half below excludes the dominion reading outright,
    // by showing the same call succeed unchanged.
    //
    // Mutation: drop `AND m.acceptedAt IS NOT NULL` from the registry's `getIdentityScope` and this
    // limb alone greens. ⚠️ Mutation-check it that way — the profile limbs above red under a
    // DIFFERENT mutation, so a whole-scenario red proves nothing about this one.
    await assert.rejects(
      () => attacker.client.impersonate(victimSubHere, evilUniverse),
      (e: unknown) => e instanceof ImpersonationMintError
        && e.status === 403 && /does not administer this subject/.test(e.message),
      'an UNACCEPTED membership let a stranger MINT a token carrying the victim profileId',
    );

    // ── The positive control: acceptance is what discriminates, not a gate that refuses all ──
    // ⚠️ **The click alone is NOT acceptance, and that is the whole discriminator.** A click sets an
    // inert cookie; `accept-membership` is the one writer of `acceptedAt`. Clicking only — which is
    // what this control used to do — left the membership in the same unaccepted state as the arm
    // above, so the two arms would have been indistinguishable and the "accepted" half vacuous. The
    // victim consents here, deliberately, because consent is the thing being shown to matter.
    await acceptInviteAndLogin({ baseUrl: origin, inviteLink, scope: evilUniverse });

    // Now a legitimately-joined co-scope admin — the capability the branch exists to serve.
    assert.equal(await refused(writeVictim()), false, 'an ACCEPTED membership did not permit the admin write');
    assert.equal(await refused(readVictimNotes()), false, 'an ACCEPTED membership did not permit the notes read');

    // The mint's own positive control — same caller, same subject, same scope, only acceptance
    // changed. Without it the refusal above would stay green against a mint that refuses everyone,
    // and it is what a message match could never have established.
    const impersonated = await attacker.client.impersonate(victimSubHere, evilUniverse);
    assert.equal(impersonated.claims?.sub, victimSubHere, 'the minted token does not name the subject');
    impersonated.disconnect();
  } finally {
    attacker.dispose();
  }

  console.error('[profile-takeover-refused] manufactured authority refused at the profile AND the mint; '
    + 'accepted membership permitted at both');
}
