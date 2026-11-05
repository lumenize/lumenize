/**
 * **A page subscribed to a Profile nobody has written heals once the person writes it, at its own
 * write or at its next new socket.**
 *
 * A Profile nobody has written answers a subscribe with the empty profile, eTag
 * `00000000000000000000000000`, and stores no subscriber, so its first write pushes to no one. A
 * Client remembers each profile whose last answer was never-written, and sends that subscribe again
 * after its own successful `updateMyProfile` and on every new socket. Two pages show it:
 *
 *  1. **Bob's own page.** Bob signs in through the real signup, whose empty consent body leaves his
 *     Profile unwritten. His page subscribes to his own profile and is answered never-written; he
 *     sets his nickname, and his page hears it within a few seconds, far inside his token's life, so
 *     no new socket can have healed it. Mutation: drop the re-send after `updateMyProfile`.
 *  2. **Alice's page.** An admin impersonates Bob with a 45-second token, and that child subscribes
 *     to Bob's profile before he writes. After his write it still hears nothing. Once its token has
 *     really lapsed (calibration §13) it sends a call, which renews the token and opens a new socket
 *     its host reports as `subscriptionRequired: false`, and Bob's nickname arrives. Recording that
 *     `onSubscriptionRequired` did not run is what shows the re-send on the new socket healed it.
 *     Mutation: drop the re-send in `#handleConnectionStatus`.
 *
 * Every limb runs and the verdict comes at the end (`live-scenarios.md`). Real logins throughout
 * (ADR-009 rung 1): Bob founds a Star under the run's shared app, and its owner signs in by email.
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import { NEVER_WRITTEN_ETAG } from '@lumenize/mesh/client';
import type { ProfileChannelSnapshot } from '@lumenize/mesh/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionStarAdmin, loginViaEmail, refreshAccessToken } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

/** Above the Client's 30 s refresh-ahead window, so the child's token is not due at birth. */
const TTL_SECONDS = 45;
/** A push that is coming arrives well inside this; it is far shorter than any token's life. */
const PUSH_MS = 5_000;

async function waitFor(what: string, ok: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ok();
}

async function waitForConnected(client: NebulaClient): Promise<void> {
  assert.ok(await waitFor('connected', () => client.connectionState === 'connected', 30_000),
    `client did not connect (state: ${client.connectionState})`);
}

/** Every profile push a client hears, by profileId. */
function recordPushes(client: NebulaClient): Map<string, ProfileChannelSnapshot[]> {
  const heard = new Map<string, ProfileChannelSnapshot[]>();
  client.onProfileUpdate((id, snapshot) => { heard.set(id, [...(heard.get(id) ?? []), snapshot]); });
  return heard;
}

const nicknameOf = (snapshot: ProfileChannelSnapshot | undefined) =>
  (snapshot?.value as { nickname?: string } | undefined)?.nickname;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const browser = new Browser();
  const app = await sharedApp(stack, testToken);
  const star = `${app.galaxy}.${testSlug('heal')}`;
  const nickname = `Bob ${crypto.randomUUID().slice(0, 6)}`;

  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  // Bob founds a Star of his own through the real signup, which writes nothing to his Profile.
  const bob = await provisionStarAdmin({
    baseUrl: stack.baseUrl, scope: star, ownerEmail: app.ownerEmail, testToken, fetchImpl: browser.fetch,
  });
  const bobCtx = new Browser().context(scopeUrlOf(stack, star));
  const bobClient = new NebulaClient({
    baseUrl: scopeUrlOf(stack, star), platformOrigin: stack.baseUrl,
    ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION, accessToken: bob.accessToken,
    instanceName: `${bob.sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: bobCtx.fetch, sessionStorage: bobCtx.sessionStorage, BroadcastChannel: bobCtx.BroadcastChannel,
  });
  const clients: NebulaClient[] = [bobClient];
  try {
    await waitForConnected(bobClient);
    const profileId = bobClient.claims!.profileId!;
    const bobHeard = recordPushes(bobClient);

    // ── The admin, impersonating Bob with a short-lived token, on Bob's own Star's page ──────────
    const adminSession = await loginViaEmail({
      baseUrl: stack.baseUrl, authScope: app.universe, email: app.ownerEmail, testToken, fetchImpl: browser.fetch,
    });
    const admin = await refreshAccessToken(stack.baseUrl, adminSession, star, browser.fetch);
    const adminCtx = browser.context(scopeUrlOf(stack, star));
    const adminClient = new NebulaClient({
      baseUrl: scopeUrlOf(stack, star), platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION, accessToken: admin.accessToken,
      instanceName: `${admin.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: adminCtx.fetch, sessionStorage: adminCtx.sessionStorage, BroadcastChannel: adminCtx.BroadcastChannel,
    });
    clients.push(adminClient);
    await waitForConnected(adminClient);
    const alice = await adminClient.impersonate(bob.sub, { ttlSeconds: TTL_SECONDS });
    clients.push(alice);
    await waitForConnected(alice);
    const aliceHeard = recordPushes(alice);
    // Counted from here on: her first connection has already run it, as every first connection does.
    let resubscribesRequired = 0;
    const required = alice.onSubscriptionRequired.bind(alice);
    alice.onSubscriptionRequired = () => { resubscribesRequired += 1; required(); };

    // ── Both pages subscribe before Bob writes, and are answered never-written ─────────────────
    using bobHandle = bobClient.subscribeProfile(profileId);
    using aliceHandle = alice.subscribeProfile(profileId);
    const [bobFirst, aliceFirst] = await Promise.all([bobHandle.snapshot, aliceHandle.snapshot]);
    limb('Bob\'s page is answered with the never-written profile', bobFirst.meta.eTag === NEVER_WRITTEN_ETAG,
      `eTag ${bobFirst.meta.eTag}`);
    limb('Alice\'s page is answered with the never-written profile', aliceFirst.meta.eTag === NEVER_WRITTEN_ETAG,
      `eTag ${aliceFirst.meta.eTag}`);

    // ── LIMB 1: Bob writes, and his own page hears it ───────────────────────────────────────────
    const tokenExp = (bobClient.claims as unknown as { exp: number }).exp;
    await bobClient.updateMyProfile({ nickname });
    const bobHealed = await waitFor('Bob hears his name', () =>
      (bobHeard.get(profileId) ?? []).some((s) => nicknameOf(s) === nickname), PUSH_MS);
    limb('limb 1 — Bob\'s page shows his nickname after his own write', bobHealed,
      `heard ${JSON.stringify((bobHeard.get(profileId) ?? []).map(nicknameOf))}`);
    limb('limb 1 — inside his token\'s life, so no new socket healed it',
      Math.floor(Date.now() / 1000) < tokenExp - 30, `token exp ${tokenExp}`);

    // ── LIMB 2: Alice's page hears nothing until its next new socket ────────────────────────────
    await new Promise((r) => setTimeout(r, 3_000));
    limb('limb 2 — Alice\'s page hears nothing from the write itself',
      !(aliceHeard.get(profileId) ?? []).some((s) => nicknameOf(s) === nickname),
      `heard ${JSON.stringify((aliceHeard.get(profileId) ?? []).map(nicknameOf))}`);

    const firstExp = (alice.claims as unknown as { exp: number }).exp;
    const waitMs = (TTL_SECONDS + 5) * 1000;
    console.error(`[unwritten-profile-heals] waiting ${waitMs / 1000}s for Alice's token to lapse…`);
    await new Promise((r) => setTimeout(r, waitMs));
    assert.ok(firstExp < Math.floor(Date.now() / 1000), 'fixture guard: Alice\'s first token must really have expired');

    // A call renews the token, and the renewed token opens a new socket.
    await alice.lmz.callAsync('STAR', star, alice.ctn<Star>().getStarConfig());
    const aliceHealed = await waitFor('Alice hears the name', () =>
      (aliceHeard.get(profileId) ?? []).some((s) => nicknameOf(s) === nickname), PUSH_MS);
    limb('limb 2 — Alice\'s page shows Bob\'s nickname after its new socket', aliceHealed,
      `heard ${JSON.stringify((aliceHeard.get(profileId) ?? []).map(nicknameOf))}`);
    limb('limb 2 — the token renewed', (alice.claims as unknown as { exp: number }).exp > firstExp,
      'the child kept its first token');
    limb('limb 2 — its host did not ask it to re-subscribe, so only the re-send healed it',
      resubscribesRequired === 0, `onSubscriptionRequired ran ${resubscribesRequired} time(s)`);
  } finally {
    for (const c of clients.reverse()) { try { c[Symbol.dispose](); } catch { /* already disposed */ } }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
