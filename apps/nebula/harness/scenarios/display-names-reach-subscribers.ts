/**
 * The names a person gives at consent reach everyone watching their profile.
 *
 * `POST /auth/{scope}/accept-membership` takes the nickname (and optional full name) along with the
 * acceptance, and the auth Worker writes them through `Profile.setDisplayNames` — a raw RPC, the one
 * Nebula caller of the Profile's fan-out that brings no mesh call context. The fan-out then pushes the
 * new snapshot to every subscriber through `lmz.broadcast`. Two limbs, one real person throughout:
 *
 *  1. **A first acceptance lands the names without a failure.** No mesh call has reached a brand-new
 *     person's Profile yet, and nobody is subscribed to it. The names must be there when they then
 *     subscribe, and — where the local stack's stdio is captured — the Worker must not have logged a
 *     failed display-name write, which is what a Profile reading an identity the mesh never stamped
 *     produces. *Reds against `Profile.#profileId()` reading `lmz.instanceName`.*
 *  2. **A later acceptance reaches a live subscriber.** The same person, now signed in with a tab
 *     subscribed to their own profile, claims a second Universe and accepts it under a new nickname.
 *     That tab must hear the new nickname. *Reds against a `broadcast` that needs a call context.*
 *
 * ⚠️ **Nothing is constructed.** Both memberships come from real claims, real letters and real
 * clicks (ADR-009 rung 1), and the accept is the POST the consent modal sends, with a nickname —
 * which the shared `acceptMembership` helper deliberately omits, so this file sends it itself.
 *
 * ⚠️ **Every limb runs and the verdict comes at the end** (`.claude/rules/live.md`), and limb 1's
 * log half is reported as not observable on a deployed target, which captures no stdio.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import {
  requestUniverseClaim, refreshTokenForScope, setCookieHeaders, refreshAccessToken,
} from '../../test/lib/email-login';

export const needsContainer = false;

/** The accept route's failure warning is what limb 1 looks for, so its namespace must print. */
export const bootVars = { DEBUG: 'nebula-auth.worker.acceptMembership' };

/** A push crosses one process boundary. Past this it is a failure, not slowness. */
const PUSH_TIMEOUT_MS = 8_000;

/** A tab that records every profile snapshot pushed to it. */
class ProfileWatcher extends NebulaClient {
  nicknames: Array<string | undefined> = [];

  override handleProfileUpdate(profileId: string, result: any): void {
    if (result && !(result instanceof Error)) this.nicknames.push(result.value?.nickname);
    return super.handleProfileUpdate(profileId, result);
  }
}

/**
 * ⚠️ **An override is a NEW function, and the mark lives on the function value — so it does not
 * inherit.** Production spells the decorator `@mesh()`; this file runs under `tsx`, which does not
 * transform TC39 decorators, so it sets the same flag the decorator sets.
 */
(ProfileWatcher.prototype.handleProfileUpdate as any)[Symbol.for('lumenize.mesh.callable')] = true;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const person = uniqueTestEmail();
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = `names-a-${suffix}`;
  const second = `names-b-${suffix}`;
  const browser = new Browser();
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(58)} ${detail}`);
  };

  /** Claim `universe` for `person` and accept it under `nickname`, as the consent modal does. */
  const claimAndAccept = async (universe: string, nickname: string): Promise<string> => {
    const waiter = waitForEmail({ testToken, instance: universe, to: person, timeout: 60_000 });
    let link: string;
    try {
      const claimed = await requestUniverseClaim({ baseUrl: origin, universe, email: person, fetchImpl: browser.fetch });
      assert.notEqual(claimed, null, `the Universe "${universe}" was already claimed`);
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup(); // a leaked waiter's WebSocket keeps Node's event loop alive past the verdict
    }
    const clicked = await browser.fetch(link, { redirect: 'manual' });
    const refreshToken = refreshTokenForScope(setCookieHeaders(clicked), universe);
    assert.ok(refreshToken, `the claim link (${clicked.status}) set no refresh-token cookie for "${universe}"`);
    const accepted = await browser.fetch(`${origin}/auth/${universe}/accept-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${refreshToken}` },
      body: JSON.stringify({ nickname }),
    });
    assert.equal(accepted.status, 200, `accept-membership for "${universe}" answered ${accepted.status}`);
    return refreshToken;
  };

  let watcher: ProfileWatcher | undefined;
  try {
    // ── LIMB 1: a first acceptance, on a Profile the mesh has never reached ────────────────────
    const refreshToken = await claimAndAccept(first, 'First');
    const { accessToken, sub } = await refreshAccessToken(origin, { refreshToken, authScope: first }, first, browser.fetch);
    const ctx = browser.context(origin);
    watcher = new ProfileWatcher({
      baseUrl: origin,
      authScope: first,
      activeScope: first,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      accessToken,
      instanceName: `${sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    const deadline = Date.now() + 30_000;
    while (watcher.connectionState !== 'connected') {
      assert.ok(Date.now() < deadline, `the tab never reached connected (state=${watcher.connectionState})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const profileId = watcher.claims.profileId;
    assert.ok(profileId, 'the session carries a profileId claim');
    const handle = watcher.subscribeProfile(profileId);
    const initial = await handle.snapshot as { value?: { nickname?: string } } | null;

    // ⚠️ **Wait for the accept's own request line before counting.** The stack's stdio reaches this
    // process late and in bursts, and a count read before the warning arrives passes on a tree where
    // the write failed — measured, one run in two. The Worker logs the warning before it answers,
    // and wrangler logs the request after, so once that line is here the warning would be too; its
    // presence is also what shows the capture works at all.
    const acceptLine = `POST /auth/${first}/accept-membership`;
    let stdio = stack.logs?.();
    const captureDeadline = Date.now() + PUSH_TIMEOUT_MS;
    while (stdio !== undefined && !stdio.includes(acceptLine) && Date.now() < captureDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      stdio = stack.logs?.();
    }
    assert.ok(stdio === undefined || stdio.includes(acceptLine),
      `the first accept's request line never reached the captured stdio, so its failed writes cannot be counted`);
    const failedWrites = stdio === undefined ? undefined
      : stdio.split('\n').filter((line) => line.includes('display-name write failed')).length;
    const namesLanded = initial?.value?.nickname === 'First';
    // Unobservable on a deployed target, so it cannot fail there — the names half still can.
    const noFailedWrite = failedWrites === undefined || failedWrites === 0;
    record('first acceptance: the names land, and no write failed',
      namesLanded && noFailedWrite,
      `the nickname on subscribe is ${JSON.stringify(initial?.value?.nickname)}; ` +
      (failedWrites === undefined
        ? 'failed writes not observable on a deployed target — no stdio capture'
        : `${failedWrites} failed display-name write(s) logged`));

    // ── LIMB 2: a later acceptance, with this person's own tab subscribed ──────────────────────
    //    POSITIVE CONTROL: the tab already heard its initial snapshot, so the subscription is live.
    const heardBefore = watcher.nicknames.length;
    await claimAndAccept(second, 'Second');
    const pushDeadline = Date.now() + PUSH_TIMEOUT_MS;
    while (!watcher.nicknames.slice(heardBefore).includes('Second') && Date.now() < pushDeadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    record('a later acceptance reaches the live subscriber',
      heardBefore > 0 && watcher.nicknames.slice(heardBefore).includes('Second'),
      `the tab heard ${heardBefore} snapshot(s) before, then ${JSON.stringify(watcher.nicknames.slice(heardBefore))}`);

    const open = results.filter((r) => !r.ok);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} display-name properties do not hold:\n` +
      open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    try { watcher?.[Symbol.dispose](); } catch { /* already disposed */ }
  }
}
