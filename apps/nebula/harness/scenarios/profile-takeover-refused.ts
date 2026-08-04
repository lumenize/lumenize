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
 * This drives the whole chain against a running server: two real email logins, a real invite, a real
 * client with a real token, and the profile reached through the real Gateway.
 *
 * ⚠️ **Why this exists when two in-lane tests already cover it.** They cover it on **stacked
 * fixtures** — `profile-do.test.ts` hand-`INSERT`s the registry rows (`seedIdentity`) *and* mints a
 * synthetic token (`createNebulaTestToken`, ADR-009 rung 3), while `identity-authority.test.ts`
 * asserts at the registry level rather than on the refusal a caller actually receives. Both are worth
 * keeping — they run in CI with no email infrastructure — but neither proves an attacker is refused;
 * they prove a hand-built approximation of one is. This build twice shipped a seeded fixture in the
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
import { provisionAndLogin, pointLinkAt } from '../../test/lib/email-login';

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
    try {
      const res = await fetch(`${origin}/auth/${evilUniverse}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attacker.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: [victimEmail] }),
      });
      assert.equal(res.status, 200, `invite failed: ${res.status}`);
      // `extractMagicLink` is magic-link-specific by design; an invite is `accept-invite?invite_token=`,
      // and the `&amp;` in an email body must be unescaped or the link 404s.
      const html = (await waiter.emailPromise).html ?? '';
      const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
      assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
      inviteLink = pointLinkAt(origin, href.replace(/&amp;/g, '&'));
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

    // ── The positive control: acceptance is what discriminates, not a gate that refuses all ──
    const accepted = await fetch(inviteLink, { redirect: 'manual' });
    assert.ok(
      /refresh-token=/.test(accepted.headers.get('set-cookie') ?? ''),
      `the victim could not accept the invite (${accepted.status})`,
    );

    // Now a legitimately-joined co-scope admin — the capability the branch exists to serve.
    assert.equal(await refused(writeVictim()), false, 'an ACCEPTED membership did not permit the admin write');
    assert.equal(await refused(readVictimNotes()), false, 'an ACCEPTED membership did not permit the notes read');
  } finally {
    attacker.dispose();
  }

  console.error('[profile-takeover-refused] manufactured authority refused; accepted membership permitted');
}
