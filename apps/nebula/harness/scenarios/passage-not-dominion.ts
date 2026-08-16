/**
 * **The two directions, driven live: upward passage RETURNS, upward dominion REFUSES — and downward
 * passage without dominion is gone.**
 *
 * ADR-015's whole point is that these are different verdicts, and the failure mode is collapsing
 * them into one. Both halves are asserted here over **NAMED METHODS**, because "denied" is also
 * what a boundary refusal produces — a criterion whose only observable is a denial cannot red
 * against the collapse it exists to catch.
 *
 * 🚨 **Do NOT "fix" the upward arm into a denial.** ADR-015 § *Terminology*'s *Lacking dominion is
 * not a denial* bullet: a caller with passage but no dominion may still be granted a great deal by
 * the methods it reaches, as the callee's own guards decide. A Star member reading its Galaxy's
 * ontology is exactly that shape and MUST be granted. Several reviewers have reached for the
 * denial reading; it is wrong every time.
 *
 * Three limbs:
 *  1. **Upward passage confers no dominion.** A star-scoped member reaches its parent Galaxy:
 *     `Galaxy.getLatestOntologyVersion` (bare `@mesh()`) RETURNS, while `Galaxy.setGalaxyConfig`
 *     (`@mesh(requireDominionHere)`) REFUSES. Collapse either direction and exactly one flips.
 *  2. **Downward is total for an admin.** The Galaxy admin's own `setGalaxyConfig` succeeds, so
 *     limb 1's refusal is about the CALLER's dominion rather than a method nobody can call.
 *  3. **A non-admin reaches its own scope and nothing beneath it.** The star-scoped member is
 *     refused at a SIBLING Star under the same Galaxy — the movement that existed until passage
 *     stopped reading the client-chosen `aud`, and the one with no consumer behind it.
 *
 * ⚠️ **Real logins throughout (ADR-009 rung 1), and that is what makes limb 3 meaningful.**
 * `provisionStarAdmin` claims a Star through the open self-signup path, so the member's `authScope`
 * is the Star itself — decided by the server, not by a fixture that could have been built in the
 * shape that passes either way.
 *
 * `needsContainer = false` — auth and mesh calls only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import {
  provisionStarAdmin, provisionAndLogin, refreshAccessToken, pointLinkAt,
} from '../../test/lib/email-login';

export const needsContainer = false;

/**
 * Minimal STRUCTURAL shapes for the two nodes this scenario calls — declared locally rather than
 * imported from `@lumenize/nebula`, which would drag `cloudflare:workers` into a Node process
 * (`mesh.md` § dependency direction; the same reason `Profile`'s fanout declares its receiver
 * inline). Only the members actually called need to be listed, and each is named exactly as the
 * criterion names it — the pair is the point, so a rename that broke one would show up here.
 */
interface GalaxyMethods {
  /** Bare `@mesh()` — reachable on upward PASSAGE alone. */
  getLatestOntologyVersion(): unknown;
  /** `@mesh(requireDominionHere)` — needs DOMINION, which upward passage does not confer. */
  setGalaxyConfig(key: string, value: unknown): void;
}
interface StarMethods {
  /** Bare `@mesh()` — reachable by any caller with passage into the Star. */
  getStarConfig(): Record<string, unknown>;
}

/**
 * The refusal MESSAGE, or `null` if the call succeeded.
 *
 * 🚨 **Returning the message, not a boolean, is the point.** A bare "did it reject?" cannot tell a
 * DOMINION refusal from a BOUNDARY refusal — and that is the exact collapse ADR-015 names and this
 * scenario exists to catch. It has already bitten this file once (an early draft called a Galaxy
 * method Star does not have, and the resulting refusal satisfied the assertion for the wrong
 * reason). Every refusal limb below matches the message it expects.
 */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `pnd-${suffix}`;
  const galaxy = `${universe}.app`;
  const star = `${galaxy}.tenant`;
  const sibling = `${galaxy}.other`;

  // A real Star founder: `claim-star` self-signup mints them admin AT the Star, so the server puts
  // exactly that Star in their `authScope` — which is the whole point, and the one thing
  // `provisionAndLogin` cannot give you (it climbs from the universe, so its token is a universe
  // admin's). It also founds the universe + galaxy above as `owner-${email}`, a DIFFERENT identity,
  // which is what makes the founder a genuine tenant rather than the owner.
  const memberEmail = uniqueTestEmail();
  const starAdmin = await provisionStarAdmin({
    baseUrl: origin, scope: star, email: memberEmail, testToken,
  });

  // The owner identity that `provisionStarAdmin` just created above, logged in for real. It exists
  // at the UNIVERSE (that is where `claim-universe` minted it), so this is a universe admin — which
  // is what limb 2 needs: dominion over the galaxy, held from above.
  const ownerSession = await provisionAndLogin({
    baseUrl: origin, scope: universe, email: `owner-${memberEmail}`, testToken,
  });

  // A sibling Star under the same Galaxy — limb 3's target, created by the owner (`create-star`
  // registers the scope and mints no identity, which is exactly right: nobody has passage into it).
  const created = await fetch(`${origin}/auth/create-star`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerSession.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyStarId: sibling }),
  });
  assert.ok([201, 409].includes(created.status), `create-star ${created.status} for ${sibling}`);

  // Both clients are built from tokens the SERVER issued (rung 1) — nothing here constructs a claim.
  const member = await connectDriver(stack, {
    scope: star,
    session: { accessToken: starAdmin.accessToken, sub: starAdmin.sub },
  });
  const owner = await connectDriver(stack, {
    scope: galaxy,
    session: { accessToken: ownerSession.accessToken, sub: ownerSession.sub },
  });

  try {
    // ── LIMB 1a: upward PASSAGE — the bare `@mesh()` method RETURNS ─────────────────────────────
    // A Star member calling its parent Galaxy. `getLatestOntologyVersion` returns `null` when no
    // ontology has been appended, which is a RETURN, not a refusal — the distinction this limb is
    // about. Asserting "did not throw" is therefore the correct assertion, and asserting a
    // particular value would make it about the ontology instead of about passage.
    const read = member.client.lmz.callAsync(
      'GALAXY', galaxy, member.client.ctn<GalaxyMethods>().getLatestOntologyVersion(),
    );
    assert.equal(
      await refusal(read), null,
      'a Star member was REFUSED a bare @mesh() read on its own parent Galaxy — upward passage is ' +
      'gone, which collapses ADR-015 clause 3 into a denial',
    );

    // ── LIMB 1b: upward DOMINION — the guarded method on the SAME node REFUSES ──────────────────
    // Same caller, same node, one call apart. That is what makes this pair capable of catching a
    // collapse: a change that granted dominion upward reds here while limb 1a stays green, and a
    // change that refused passage upward reds there while this stays green.
    const write = member.client.lmz.callAsync(
      'GALAXY', galaxy, member.client.ctn<GalaxyMethods>().setGalaxyConfig('pwned', true),
    );
    // ⚠️ Match the DOMINION message. A bare "rejected" would also be satisfied by a boundary
    // refusal, i.e. by the caller never reaching the Galaxy at all — which would mean limb 1a is
    // broken and this limb is silently agreeing with it.
    const writeRefusal = await refusal(write);
    assert.match(
      writeRefusal ?? '(succeeded)', /Admin access required/,
      'a Star member must be refused setGalaxyConfig by DOMINION (requireDominionHere), not by the ' +
      `passage boundary — upward dominion is nil (ADR-015 clause 2). Got: ${writeRefusal}`,
    );

    // ── LIMB 2: the control — the Galaxy's OWN admin may write it ───────────────────────────────
    // Without this, limb 1b stays green against a `setGalaxyConfig` nobody can call at all.
    const ownerWrite = owner.client.lmz.callAsync(
      'GALAXY', galaxy, owner.client.ctn<GalaxyMethods>().setGalaxyConfig('ok', true),
    );
    assert.equal(
      await refusal(ownerWrite), null,
      'the Galaxy\'s own admin was refused its own guarded method — limb 1b would then be vacuous',
    );

    // ── LIMB 3: a non-admin reaches its own scope and NOTHING BENEATH it ────────────────────────
    // 🚨 **The principal here is deliberately a GALAXY non-admin, not the Star member above**, and
    // that choice is what makes this limb capable of failing. The Star member is refused at the
    // sibling under BOTH the old rule and the new one (neither its `aud` nor its scope covers a
    // sibling), so asserting on it would be green either way — a test that cannot fail.
    //
    // A galaxy-tier NON-admin is the one shape the two rules disagree about: their `authScope` is
    // `{u}.{g}`, and the refresh confine happily mints them `aud = {u}.{g}.{s}` because the Star IS
    // beneath their scope. Under the old `aud`-keyed tenant arm that token passed at the Star —
    // reaching a tenant they hold no membership in. Under `authScope` it is refused, because the
    // Star is beneath them and they hold no dominion. Restore the `aud` read and this goes GREEN
    // on the wrong behaviour, which is exactly what it exists to catch.
    const outsiderEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: galaxy, to: outsiderEmail, timeout: 60_000 });
    let inviteLink: string;
    try {
      const invited = await fetch(`${origin}/auth/${galaxy}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerSession.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: [outsiderEmail] }),
      });
      assert.equal(invited.status, 200, `invite into ${galaxy} failed: ${invited.status}`);
      const html = (await waiter.emailPromise).html ?? '';
      const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
      assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
      inviteLink = pointLinkAt(origin, href.replace(/&amp;/g, '&'));
    } finally {
      waiter.cleanup();   // a leaked waiter's WebSocket hangs the process AFTER the verdict prints
    }
    const acceptRes = await fetch(inviteLink, { redirect: 'manual' });
    const refreshToken = /refresh-token=([^;]+)/.exec(acceptRes.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(refreshToken, `the galaxy invite was not accepted (${acceptRes.status})`);

    // The server WILL mint them a token whose `aud` is the Star beneath — that is not the bug, and
    // asserting it here is what proves the refusal below comes from passage rather than the mint.
    const intoStar = await refreshAccessToken(origin, { refreshToken, authScope: galaxy }, star);
    assert.ok(intoStar.accessToken, 'a galaxy member could not even mint a token aimed at the Star');

    const outsider = await connectDriver(stack, {
      scope: star,
      session: { accessToken: intoStar.accessToken, sub: intoStar.sub },
    });
    try {
      // ⚠️ **The positive control comes FIRST, and it is not optional.** `getStarConfig` is a bare
      // `@mesh()` method on Star; the Star's OWN member must be able to call it, or the refusal
      // below would prove only that the method is unreachable — which is how this limb was first
      // written (against a Galaxy method Star does not have) and why it could not fail.
      const ownRead = member.client.lmz.callAsync(
        'STAR', star, member.client.ctn<StarMethods>().getStarConfig(),
      );
      assert.equal(
        await refusal(ownRead), null,
        'the Star\'s own member could not call a bare @mesh() method on it — the refusal below ' +
        'would then be vacuous',
      );

      const descend = outsider.client.lmz.callAsync(
        'STAR', star, outsider.client.ctn<StarMethods>().getStarConfig(),
      );
      // ⚠️ Match the PASSAGE message. This limb is about never reaching the node at all; a
      // dominion refusal here would mean the caller DID get in and was stopped by a method guard,
      // which is a different (and weaker) property than the one being asserted.
      const descendRefusal = await refusal(descend);
      assert.match(
        descendRefusal ?? '(succeeded)', /Active-scope mismatch/,
        'a GALAXY-tier non-admin must be refused at the PASSAGE boundary of a tenant Star beneath ' +
        `it — downward passage without dominion is impossible by construction. Got: ${descendRefusal}`,
      );
    } finally {
      outsider.dispose();
    }
  } finally {
    member.dispose();
    owner.dispose();
  }

  console.error(
    '[passage-not-dominion] upward read returned, upward write refused, owner write succeeded, ' +
    'galaxy non-admin refused at the Star beneath it',
  );
}
