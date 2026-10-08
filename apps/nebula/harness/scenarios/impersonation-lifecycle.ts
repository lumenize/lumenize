/**
 * Impersonation, end to end on the RUNNING system — the behavioural coverage for
 * `tasks/archive/nebula-impersonation-client.md`, moved here from the vitest-plugin lane.
 *
 * Companion to `impersonation-expiry`, which owns the one thing needing a real clock. This one owns
 * everything deterministic: identity, the mint, refusals, concurrency, teardown and readiness.
 *
 * **Why here rather than in `test-apps/baseline`** (`live.md` § `/live` is the DEFAULT tier): the
 * baseline versions were mutation-validated and still wrong three times, in ways a running system
 * makes hard to construct. Two of them reached for test-only affordances that DO NOT EXIST
 * (`lmzTestDropSocket`, `__onLoginRequiredProbe`) — silent no-ops that made the tests assert nothing.
 * Here there is no test subclass to reach through and no `as any`: a socket drop has to be a real
 * supersede, and a login-required probe has to be a real config hook, because nothing else is
 * available. The affordance that produced those bugs is simply absent.
 *
 * ⚠️ One narrative `it`-equivalent, sequential, sharing one boot — `testing.md` § narrative for-docs
 * tests. Each step's failure mode is named at the step, and every assertion here was mutation-checked
 * against the source (see the task file's phase criteria for the mutation each one carries).
 *
 * No DevContainer: `needsContainer = false`, so this boots without Docker.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { Browser } from '@lumenize/testing';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import type { NebulaStoreAdapter } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, StudioClient } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { chatPairOf, connectDriver, constructionPairs, inviteViaMesh, readDevVar, scopeUrlOf } from '../lib/harness';
import {
  provisionStarAdmin, loginViaEmail, refreshAccessToken, acceptInviteAndLogin,
} from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { debugLines } from '../lib/stdio';
import { waitForEmail } from '@lumenize/email-test/client';
import { ImpersonationChainError, ImpersonationMintError } from '@lumenize/mesh/client';
import { childrenOf, isTornDown } from '../../../../packages/mesh/src/impersonation';
import type { AuthFacade } from '@lumenize/mesh/auth/facade';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.facade.impersonate,lmz.mesh.ClientGateway.acceptUpgrade' };

/** Outside the client's 30s refresh-ahead window, so nothing here re-mints on its own. */
const SAFE_TTL = 300;
/** Inside it — a token born due, so every `connect()` re-mints. */
const REMINT_TTL = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connected(client: NebulaClient, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (client.connectionState === 'connected') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not connect within ${timeoutMs}ms (state: ${client.connectionState})`);
}

/**
 * Invite a second identity INTO an existing scope, through the real email loop.
 *
 * ⚠️ This is what makes the dangerous SAME-SCOPE shape reachable, and its absence was the reason I
 * wrongly concluded the harness could not build it: I looked for an exported helper, found none, and
 * stopped — rather than checking whether the primitives existed. They do. Every `@lumenize-test.dev`
 * address is routed by the catch-all to the email-test Worker, so the invite mail is catchable
 * exactly like a magic link, and login alone never mints an identity — an invite is the only way to
 * put a SECOND person inside a scope someone else founded.
 */
async function inviteAndLogin(
  stack: DevStack, scope: string, adminSession: { accessToken: string; sub: string },
  email: string, testToken: string, scopeAdmin = false,
): Promise<{ accessToken: string; sub: string }> {
  // The invitee's own browser: a browser holding the admin's cookie would be the admin on every
  // page beneath, since the refresh picks the broadest admin membership its cookies reach.
  const browser = new Browser();
  // NO `instance` FILTER, but we DO assert the tag's value below — two different things, and the
  // reason for each has changed over time. The filter could once not work at all (`AuthEmailSender`
  // stamped `X-Lumenize-Auth-Instance` per message TYPE and covered magic-link only, so an invite
  // landed in the catch-all bucket and an `instance: scope` filter silently never matched — one 60s
  // timeout to find). Since 2026-07-31 the tag is stamped from `EmailMessage.instanceName`, required
  // on every variant, so the filter WOULD match. We still filter on `to`: a unique recipient skips
  // the shared-bucket `clear` that `instance` performs, so this stays safe beside a concurrently-
  // waiting listener.
  const waiter = waitForEmail({ testToken, to: email, timeout: 60_000 });
  try {
    // The ONE production surface: NebulaClient.invite → its host node → facade (there is no HTTP route).
    const summary = await inviteViaMesh(stack, adminSession, scope, [{ email, scopeAdmin }]);
    assert.equal(summary.errors.length, 0, `invite to ${scope} failed: ${JSON.stringify(summary.errors)}`);
    const email_ = await waiter.emailPromise;
    // ⚠️ Assert the tag's VALUE, not merely that mail arrived. What this pins is that the value comes
    // from the caller-supplied field and is correct. (Deliberately NOT
    // added for magic-link: `apps/nebula/test/lib/email-login.ts` already passes `instance`, so a
    // wrong tag there already times out every `/live` boot.)
    assert.equal(
      email_.instance, scope,
      `invite mail must be tagged with its instance (got ${email_.instance ?? 'undefined'})`,
    );
    const html = email_.html ?? '';
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no magic link (subject: ${html.slice(0, 60)})`);
    const link = href.replace(/&amp;/g, '&');
    const { refreshToken } = await acceptInviteAndLogin({
      baseUrl: stack.baseUrl, inviteLink: link, scope, fetchImpl: browser.fetch,
    });
    return refreshAccessToken(stack.baseUrl, { refreshToken, authScope: scope }, scope, browser.fetch);
  } finally {
    waiter.cleanup();
  }
}

/** A store that hands each pushed Chat title to `heard`, where the factory's store would show it. */
function recordingStore(heard: (title: string) => void): NebulaStoreAdapter {
  const ignore = (): void => {};
  return {
    readResource: () => ({ value: undefined }),
    applyServer: ignore, applyCommit: ignore, rollbackTo: ignore, applyDenied: ignore,
    applyResolvedValue: ignore, applyOptimistic: ignore, flash: ignore,
    applyFanout: (_rt, _rid, snapshot) => heard((snapshot.value as { title: string }).title),
  };
}

async function until(what: string, fn: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const browser = new Browser();
  const suffix = crypto.randomUUID().slice(0, 8);
  // The run's shared app, with a Star of this scenario's own beneath it; its owner is our ADMIN.
  const app = await sharedApp(stack, testToken);
  const universe = app.universe;
  const star = `${app.galaxy}.${testSlug('impl')}`;
  const subjectEmail = `subject-${suffix}@lumenize-test.dev`;

  let loginRequiredFired = false;

  // The SUBJECT: a real star-scoped admin, in a browser of their own.
  const subject = await provisionStarAdmin({
    baseUrl: stack.baseUrl, scope: star, email: subjectEmail, ownerEmail: app.ownerEmail, testToken, fetchImpl: new Browser().fetch,
  });
  const adminSession = await loginViaEmail({
    baseUrl: stack.baseUrl, authScope: universe, email: app.ownerEmail,
    testToken, fetchImpl: browser.fetch,
  });

  // An impersonation's child acts on its parent's page, so the parent refreshes at the subject's
  // own scope — the star — for the subject's limbs, and at the universe for the same-scope peer's.
  const mkAdminClient = async (page: string) => {
    // A page on `page`'s own host: its socket connects there, and its refresh names it in `Origin`.
    const ctx = browser.context(scopeUrlOf(stack, page));
    const token = await refreshAccessToken(stack.baseUrl, adminSession, page, browser.fetch);
    const client = new NebulaClient({
      baseUrl: scopeUrlOf(stack, page),
      platformOrigin: stack.baseUrl,
      // Inert — this scenario drives impersonation, never a resource op.
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      accessToken: token.accessToken,
      instanceName: `${token.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      // A REAL config hook, which is the only kind there is here. The baseline version of this
      // assertion set an invented instance property that nothing read, so it could never fire.
      onLoginRequired: () => { loginRequiredFired = true; },
    });
    await connected(client);
    return { client, token };
  };
  const { client: adminClient, token: admin } = await mkAdminClient(star);

  // Count the parent's calls to the facade — the transport every mint rides, and so the place a
  // refused call would have shown. Observation only: each call passes straight through.
  let mintRequests = 0;
  const realCallAsync = adminClient.lmz.callAsync;
  (adminClient.lmz as { callAsync: unknown }).callAsync = (binding: string, ...rest: unknown[]) => {
    if (binding === 'AUTH_FACADE') mintRequests++;
    return (realCallAsync as (...a: unknown[]) => unknown)(binding, ...rest);
  };

  // ── 1. The returned client IS the subject, and authority is REDUCED ─────────────────────────────
  const child = await adminClient.impersonate(subject.sub, { ttlSeconds: SAFE_TTL });
  await connected(child);
  assert.equal(child.claims.sub, subject.sub, 'the child must be the subject');
  assert.equal(child.claims.act?.sub, admin.sub, 'the admin must be the actor');
  assert.equal(child.claims.aud, star, "the child's page must be its parent's");
  const mintsAfterFirst = mintRequests;
  assert.equal(mintsAfterFirst, 1, 'impersonate() must mint EXACTLY once (mint-then-seed)');

  // ── 1a. The mint's record names the page ────────────────────────────────────────────────────────
  // ADR-016: a mint establishes a session, so its record names the subject beside the caller's
  // whole projected claims, the page included. Read from the stack's stdio, waiting for the record
  // itself, which is the line this limb reads; a deployed target captures none.
  // Mutation: strip the claims from the record → it names only the subject → reds.
  if (stack.logs) {
    const deadline = Date.now() + 20_000;
    let record: { data: { subOfNarrowerToken?: string; actingToken?: Record<string, unknown> } } | undefined;
    while (!record && Date.now() < deadline) {
      for (const block of (stack.logs() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split(/\n(?=\{\n)/)) {
        const end = block.indexOf('\n}');
        if (end < 0) continue;
        try {
          const obj = JSON.parse(block.slice(0, end + 2));
          if (obj.message === 'Impersonation token issued' && obj.data?.subOfNarrowerToken === subject.sub) record = obj;
        } catch { /* not one of ours */ }
      }
      if (!record) await sleep(100);
    }
    assert.ok(record, 'the mint logged no record');
    assert.equal(record.data.actingToken?.sub, admin.sub, "the mint's record must carry the caller's claims");
    assert.equal(record.data.actingToken?.aud, star, "the mint's record must name the caller's page");
    assert.ok(record.data.actingToken?.access, "the mint's record must carry the authority asserted");
  } else {
    console.error('[impersonation-lifecycle] limb 1a record: not observable on a deployed target');
  }

  // ── 1b. MINT FIDELITY: the derived token is indistinguishable from the subject's own ────────────
  // The reference token can only be produced by the subject actually logging in — which is exactly
  // what `provisionStarAdmin` did (a real claim-star email loop), so nothing here is hand-written.
  // Fidelity, not capability: `authScope` and `scopeAdmin` are compared FIELD-FOR-FIELD against the
  // subject's real token.
  // Per-limb mutation (live.md): hard-code the mint's `scopeAdmin` to false → the bit comparison
  // below reds while limb 1's sub/act/aud assertions stay green.
  // `below` is a second subject at the Star, which the later limbs impersonate beside the first.
  let below!: Awaited<ReturnType<typeof inviteAndLogin>>;
  {
    const subjectClaims = parseJwtUnsafe(subject.accessToken)!.payload as any;
    // Concrete-value anchors FIRST: the mirror comparisons below would pass vacuously as
    // undefined === undefined under a claim-field rename; these pin the reference side to the
    // values a real claim-star login must carry.
    assert.equal(subjectClaims.access.authScope, star, "the subject's own token must carry the star as authScope");
    assert.equal(subjectClaims.access.scopeAdmin, true, "the subject's own token must carry scopeAdmin");
    const { access_token: derivedToken } = await realCallAsync('AUTH_FACADE', undefined,
      adminClient.ctn<AuthFacade>().impersonate(subject.sub, {})) as { access_token: string };
    const derived = parseJwtUnsafe(derivedToken)!.payload as any;
    assert.equal(derived.access.authScope, subjectClaims.access.authScope,
      "the derived token's authScope must be the SUBJECT's membership scope, verbatim");
    assert.equal(derived.access.scopeAdmin, subjectClaims.access.scopeAdmin,
      "the derived token's scopeAdmin must MIRROR the subject's own bit");
    assert.equal(derived.aud, star, "the caller's page becomes only the aud");

    // ⚠️ **The mint refuses a token carrying `act`** — impersonation does not chain, so the facade's
    // `impersonate` answers a derived token with a refusal naming a root identity. That refusal IS the
    // fidelity check: the two tokens are distinguishable exactly here and nowhere else, which is the
    // design, not a gap. The same call on the subject's own token, for someone beneath them, mints —
    // the positive control. Both go straight to the facade, past the client's own pre-flight, which
    // limb 2 covers. Mutation: drop the mint's `act` gate → the derived token mints → reds.
    below = await inviteAndLogin(
      stack, star, { accessToken: subject.accessToken, sub: subject.sub },
      `below-${suffix}@lumenize-test.dev`, testToken,
    );
    const asSubject = await connectDriver(stack, { scope: star, session: { accessToken: subject.accessToken, sub: subject.sub } });
    try {
      const own = await asSubject.client.lmz.callAsync('AUTH_FACADE', undefined,
        asSubject.client.ctn<AuthFacade>().impersonate(below.sub, {})) as { access_token: string };
      assert.equal((parseJwtUnsafe(own.access_token)!.payload as any).sub, below.sub,
        "the subject's OWN token must mint for someone beneath them — the positive control");
    } finally {
      asSubject.dispose();
    }
    const chained = await child.lmz.callAsync('AUTH_FACADE', undefined,
      child.ctn<AuthFacade>().impersonate(below.sub, {})).then(() => null, (e: unknown) => (e as Error).message);
    assert.match(chained ?? '(it minted)', /root identity/,
      'a derived (act-bearing) token must be refused the mint, by the root-identity message');
  }
  const mintsBeforeChain = mintRequests;

  // ── 2. Impersonation does not chain, and makes no call ──────────────────────────────────────────
  await assert.rejects(
    () => child.impersonate(subject.sub),
    (e: unknown) => e instanceof ImpersonationChainError && /does not chain/i.test((e as Error).message),
    'a child must refuse to impersonate',
  );
  assert.equal(mintRequests, mintsBeforeChain, 'the chain refusal must happen BEFORE any call');

  // ── 2b. The child is hosted by its parent's host node, and a second child of one subject is refused
  // The child connects on its parent's page, so the Star holds its socket beside its parent's under an
  // id of its own. A second child of the same subject from this tab would share that id, so
  // `impersonate()` refuses it before any call. Mutation: drop the check → the second child mints,
  // and its upgrade closes the first child's socket with 4409 → the rejection below never comes.
  if (stack.logs) {
    const name = `${star}/${child.lmz.instanceName}`;
    await until(`the Star to hold ${name}`, () => debugLines(stack.logs!()).some((e) =>
      e.message === 'WebSocket connection accepted' && e.data.instanceName === name));
  } else {
    console.error('[impersonation-lifecycle] limb 2b host: not observable on a deployed target');
  }
  const mintsBeforeSecond = mintRequests;
  await assert.rejects(
    () => adminClient.impersonate(subject.sub, { ttlSeconds: SAFE_TTL }),
    (e: unknown) => (e as Error).name === 'ImpersonationAlreadyOpenError',
    'a second child of one subject from one tab must be refused',
  );
  assert.equal(mintRequests, mintsBeforeSecond, 'the duplicate refusal must happen BEFORE any call');

  // ── 3. A failed FIRST mint rejects cleanly and leaves no half-registered child ──────────────────
  // Two refusals with different messages: one message could be satisfied by a build that hard-codes
  // it. The first is the mint's COLLAPSED refusal — an absent subject answers identically to one the
  // caller may not act for (no `sub`-existence oracle); the second is the pre-lookup self-narrow.
  const childrenBefore = childrenOf(adminClient).length;
  await assert.rejects(
    () => adminClient.impersonate(crypto.randomUUID(), { ttlSeconds: SAFE_TTL }),
    (e: unknown) => e instanceof ImpersonationMintError && /does not administer this subject/.test((e as Error).message),
    'an absent subject must get the collapsed refusal',
  );
  await assert.rejects(
    () => adminClient.impersonate(admin.sub, { ttlSeconds: SAFE_TTL }),
    (e: unknown) => e instanceof ImpersonationMintError && /different sub/.test((e as Error).message),
    'a self-narrow must be refused before the lookup',
  );
  assert.equal(childrenOf(adminClient).length, childrenBefore, 'a refused mint must leave NO child registered');

  // ── 4. A paused parent is not a dead one ────────────────────────────────────────────────────────
  // The direct regression guard for a shipped bug: hooking teardown on `disconnect()` made a parent
  // that paused and came back unable to mint, because `disconnect()` is a reversible pause and not an
  // end-of-session door. Mutation: latch teardown on `disconnect()` again → the mint after
  // `connect()` fails as terminal → reds.
  adminClient.disconnect();
  assert.equal(isTornDown(adminClient), false, 'a bare disconnect() must NOT mark the parent torn down');
  adminClient.connect();
  await connected(adminClient);
  // The second subject, since the first's child is still open.
  const afterPause = await adminClient.impersonate(below.sub, { ttlSeconds: SAFE_TTL });
  await connected(afterPause);
  assert.equal(afterPause.claims.sub, below.sub, 'the first mint after a pause must succeed');

  // ── 4b. A transport failure does not end a child ────────────────────────────────────────────────
  // The child's token is born due, so its `connect()` re-mints over the parent's socket — which the
  // parent then pauses, and holds paused past `callAsync`'s 30 s timeout, so at least one re-mint
  // rejects as transport. Once the parent reconnects, the queued re-mint lands.
  // Mutation: classify any rejection but the typed refusal as terminal → the child ends
  // `disconnected` → reds.
  // The first subject's child ends first, so this one is the subject's only open child.
  child[Symbol.dispose]();
  const pausing = await adminClient.impersonate(subject.sub, { ttlSeconds: REMINT_TTL });
  await connected(pausing);
  pausing.disconnect();
  pausing.connect();
  adminClient.disconnect();
  await sleep(35_000);
  assert.notEqual(pausing.connectionState, 'disconnected',
    "a paused parent's transport failure must not end its child");
  adminClient.connect();
  await connected(adminClient);
  await connected(pausing, 45_000);
  assert.equal(pausing.claims.sub, subject.sub, 'the re-minted child must still be the subject');

  // ── 5. Children of two subjects coexist ─────────────────────────────────────────────────────────
  assert.notEqual(afterPause.lmz.instanceName, pausing.lmz.instanceName, 'two subjects\' children must have different ids');
  assert.notEqual(afterPause.lmz.instanceName, adminClient.lmz.instanceName, 'a child must never share its parent\'s id');
  assert.equal(afterPause.connectionState, 'connected', 'the second subject\'s child must still be connected');
  assert.ok(childrenOf(adminClient).length >= 2, 'the parent must hold its live children');

  // ── 6. child.logout() is CHILD-ONLY teardown — the admin's cookie must survive ─────────────────
  // 🛑 Every refresh cookie sits at `Path=/` on the platform host, so a logout the child sent would
  // carry every cookie this browser holds, the admin's included; only `MeshClient.logout()`'s
  // `#mintedFrom` branch stands between a child logout and the admin's refresh token. The child here
  // is an invited identity AT THE UNIVERSE, impersonated from the universe's page, the ordinary
  // support shape.
  const { client: universeAdmin, token: universeToken } = await mkAdminClient(universe);
  const peerEmail = `peer-${suffix}@lumenize-test.dev`;
  const peer = await inviteAndLogin(stack, universe, universeToken, peerEmail, testToken);
  const sameScopeChild = await universeAdmin.impersonate(peer.sub, { ttlSeconds: SAFE_TTL });
  await connected(sameScopeChild);
  assert.equal(sameScopeChild.claims.sub, peer.sub, 'the same-scope child must be the invited peer');

  await sameScopeChild.logout();
  assert.equal(sameScopeChild.connectionState, 'disconnected', 'a child logout must tear the child down');

  // ⚠️ THE discriminating assertion. Revoking the admin's cookie is invisible to connectionState
  // (socket open, stateless JWT) and to impersonate() (rides a still-fresh access token) — so probe
  // the cookie itself, refreshing from the universe's page as the admin's browser does.
  const probe = await browser.context(scopeUrlOf(stack, universe)).fetch(`${stack.baseUrl}/auth/refresh-token`, {
    method: 'POST',
  });
  assert.equal(probe.status, 200, "a child logout must NOT revoke the admin's refresh cookie");
  assert.equal(universeAdmin.connectionState, 'connected', 'the admin must stay connected');

  // ── 7. Deleting the subject's Star ends the child ───────────────────────────────────────────────
  // The subject's membership goes with their Star, deleted by the admin above it. The child acts on
  // its parent's page, which is that Star, so the deletion closes its socket with 4410 and the child
  // stops for good, before any re-mint could be refused; `impersonate-lifetime.test.ts`'s TERMINAL
  // re-mint test covers a refusal. Its token is outside the refresh-ahead window, so a reconnect
  // would need no mint. Mutation: let a Client reconnect on 4410 → the child reconnects into an
  // empty Star and never settles on `disconnected` → reds.
  pausing[Symbol.dispose]();
  const ending = await adminClient.impersonate(subject.sub, { ttlSeconds: SAFE_TTL });
  await connected(ending);
  await universeAdmin.scopes.delete(star);
  await until('the child on the deleted Star to end', () => ending.connectionState === 'disconnected', 30_000);
  await sleep(3_000);
  assert.equal(ending.connectionState, 'disconnected', 'a child whose Star was deleted must stay ended');

  // ── 8. Disposing the parent tears the children down, and closes minting ─────────────────────────
  await adminClient.dispose();
  await until('the children to be torn down', () => child.connectionState === 'disconnected'
    && afterPause.connectionState === 'disconnected');
  assert.equal(isTornDown(adminClient), true, 'an end-of-session door must mark the parent');
  assert.equal(childrenOf(adminClient).length, 0, 'teardown must clear the parent’s children');
  await assert.rejects(
    () => adminClient.impersonate(subject.sub, { ttlSeconds: SAFE_TTL }),
    /torn down/i,
    'a torn-down parent must not mint again',
  );
  // The admin was never bounced to login by any of this — someone else's session ending must not
  // end theirs. (Real hook, so a false here means "did not fire", not "was never wired".)
  assert.equal(loginRequiredFired, false, "the admin's onLoginRequired must never fire");
  await universeAdmin.dispose();

  // ── 9. The child is its parent's own class, and reads and posts through what that class adds ────
  // `impersonate()` builds the child with `new this.constructor(…)`, so a `StudioClient`'s child is
  // a `StudioClient`, with a `ClientResources` of its own and the chat pair `childConfig()` passes
  // on. On the galaxy's page, where the chat lives, the subject is an admin of the galaxy, invited
  // as one, so the galaxy's Chats are theirs to read and its thread theirs to post in. The two
  // checks each run and report, so a mutation that breaks both shows both.
  // Mutation: build the child as a bare `MeshClient` → it has no `resources` and no
  // `postUserMessage` → both red.
  {
    const galaxy = app.galaxy;
    const galaxyPage = browser.context(scopeUrlOf(stack, galaxy));
    const galaxyToken = await refreshAccessToken(stack.baseUrl, adminSession, galaxy, browser.fetch);
    const studio = new StudioClient({
      baseUrl: scopeUrlOf(stack, galaxy),
      platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(galaxy),
      ...chatPairOf(galaxy),
      accessToken: galaxyToken.accessToken,
      instanceName: `${galaxyToken.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: galaxyPage.fetch,
      sessionStorage: galaxyPage.sessionStorage,
      BroadcastChannel: galaxyPage.BroadcastChannel,
    });
    await connected(studio);
    const galaxyAdmin = await inviteAndLogin(
      stack, galaxy, galaxyToken, `galaxy-admin-${suffix}@lumenize-test.dev`, testToken, true,
    );
    const chatId = crypto.randomUUID();
    await studio.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'before' } },
    });
    await studio.resources.subscribe('Chat', chatId).snapshot;
    const asAdmin = await studio.impersonate(galaxyAdmin.sub, { ttlSeconds: SAFE_TTL });
    await connected(asAdmin);
    const problems: string[] = [];
    try {
      const titles: string[] = [];
      asAdmin.bindStore(recordingStore((title) => titles.push(title)));
      const first = await asAdmin.resources.subscribe('Chat', chatId).snapshot;
      assert.equal((first?.value as { title?: string } | undefined)?.title, 'before',
        "the child's subscribe must answer with the Chat's snapshot");
      await studio.resources.transaction({ [chatId]: { op: 'put', typeName: 'Chat', value: { title: 'after' } } as any });
      await until('the child to hear the rename', () => titles.includes('after'));
    } catch (e) {
      problems.push(`the child's resources: ${(e as Error).message}`);
    }
    try {
      assert.ok(asAdmin instanceof StudioClient, "a StudioClient's child must be a StudioClient");
      const messageId = await (asAdmin as StudioClient).postUserMessage('posted while impersonating');
      const posted = await asAdmin.resources.read('Message', messageId);
      assert.equal((posted?.value as { content?: string } | undefined)?.content, 'posted while impersonating',
        "the child's post must commit as a Message");
    } catch (e) {
      problems.push(`the child's postUserMessage: ${(e as Error).message}`);
    }
    asAdmin[Symbol.dispose]();
    await studio.dispose();
    assert.equal(problems.length, 0, problems.join('\n'));
  }

  console.error('[impersonation-lifecycle] ok — identity, refusals, a paused parent, teardown, the child\'s own class');
}
