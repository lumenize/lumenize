/**
 * **A claim is not an account until its founder accepts it: nothing enters it before then, its
 * first acceptance starts its scopes empty, and every claim, consume and acceptance leaves its
 * record.**
 *
 * One account founded by a real claim carries most of the limbs: refused while pending, then
 * accepted, then used. Each limb that counts teardown markers counts only those carrying its own
 * request's id, read from that request's completion line (`live.md`).
 *
 * Limbs, each isolated (`live.md` — per limb), each refusal matched by its message:
 *
 *  1. **Nothing enters a scope its founder has not accepted.** Under a pending claim, a `claim-star`
 *     is refused `parent_not_found`, a superuser's invite with its own message, and a superuser's
 *     create `parent_not_found`; under an accepted app, an invite into a tenant whose founder is
 *     pending is refused too. Once each founder accepts, the same calls succeed. *Reds if the
 *     accepted-universe check leaves `claimStar`, `issueInvites` or `createGalaxy`, or the
 *     pending-Star check leaves `issueInvites`.*
 *  2. **A claim's first acceptance wipes the scopes it wrote before it answers**: the universe, its
 *     galaxy and `.dev` Star, or a claim-star's Star alone. *Reds if the teardown is skipped, if it
 *     covers universe claims only, or if the Worker answers before it returns.*
 *  3. **A second Accept tears nothing down, and a message posted in between survives it.** *Reds if
 *     an already-accepted membership is torn down too.*
 *  4. **Neither the root's first Accept nor an invitee's tears anything down**, and the chats they
 *     could reach survive. *Reds if any self-created admin membership counts as founding, or any
 *     first acceptance tears down.*
 *  5. **Every acceptance leaves its record**: the credential, the address, the `sub`s accepted and
 *     the scopes handed to teardown, with no acting token. *Reds if the record goes or omits them.*
 *  6. **A claim and a consume each leave theirs**: a claim names the address, the membership it
 *     opened and every scope it wrote, the ticket-backed claim included; `claim-star` names the
 *     `sub` it minted; the consume names the proved address and its sessions, with no acting token.
 *  7. **A superseded claim leaves nothing behind**: its record names the retired subtree, and the
 *     slug can be claimed again with the same first app. *Reds if convergence deletes the universe
 *     row alone.*
 *
 * Limbs 2–7's stdio halves are not observable on a deployed target, which says so per limb.
 *
 * `needsContainer = false` — auth, the Registry, the teardown hook and the chat plane only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, superuserEmail } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, refreshAccessToken, requestUniverseClaim, requestStarClaim, requestMagicLink,
  refreshTokenForScope, setCookieHeaders, acceptMembership, consumeLink, refreshCookie,
} from '../../test/lib/email-login';
import { SIGNUP_TICKET_COOKIE } from '@lumenize/mesh/client';

export const needsContainer = false;

/** A stable address for this boot, pinned as the bootstrap identity below. */
const SUPERUSER = superuserEmail('lifecycle-superuser@lumenize-test.dev');
const PLATFORM = '_platform';

export const bootVars = {
  AUTH_BOOTSTRAP_EMAIL: SUPERUSER,
  DEBUG: [
    'nebula.scope.teardown', 'nebula-auth.worker.acceptMembership',
    'nebula-auth.Registry.identity.membershipAccepted', 'nebula-auth.Registry.claimUniverse',
    'nebula-auth.Registry.claimUniverseWithTicket', 'nebula-auth.Registry.claimStar',
    'nebula-auth.Registry.login.established', 'nebula-auth.Registry.claim.converged',
  ].join(','),
};

/** The refusal MESSAGE, or `null` if the call succeeded — a refusal is matched by what it says. */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** One delivered letter, as the email-test client hands it over. */
type Mail = Parameters<typeof extractMagicLink>[0];

const chatQuery = (chatId: string) =>
  ({ queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: chatId });

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = testSlug('cl');
  const galaxy = `${universe}.crm`;
  const observable = stack.logs !== undefined;
  const drivers: Driver[] = [];
  const notObservable = (limb: string) => console.error(`[claim-lifecycle] limb ${limb}: not observable on a deployed target`);

  /** The link a send produces, armed before the send and filtered by its unique recipient. */
  const mailTo = async (
    to: string, send: () => Promise<unknown>, extract: (mail: Mail) => string = extractMagicLink,
  ): Promise<string> => {
    const waiter = waitForEmail({ testToken, to, timeout: 120_000 });
    try {
      await send();
      return extract(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
  };
  /** An invite letter's link, read from its markup. */
  const inviteLinkOf = (mail: Mail): string => {
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
    assert.ok(href, 'the invite letter carried no magic link');
    return href.replace(/&amp;/g, '&');
  };
  /**
   * Press an emailed link's button and come back with the cookie it set for `scope`. For a claim's
   * or an invite's link that is the consent screen's Accept, which accepts as it consumes; for a
   * plain login it is Continue, which accepts nothing.
   */
  const clickFor = async (link: string, scope: string): Promise<string> => {
    const clicked = await consumeLink(link);
    const cookie = refreshTokenForScope(setCookieHeaders(clicked), scope);
    assert.ok(cookie, `the link's button set no cookie for ${scope} (${clicked.status})`);
    return cookie!;
  };
  /** Home's Accept for `scope`, by the cookie named for it. */
  const postAccept = (scope: string, cookie: string) => fetch(`${origin}/auth/accept-membership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: refreshCookie(scope, cookie) },
    body: JSON.stringify({ scope }),
  });
  const claimStar = (star: string, email: string) => fetch(`${origin}/auth/claim-star`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyStarId: star, email }),
  });
  const driver = async (scope: string, session: { accessToken: string; sub: string }) => {
    const d = await connectDriver(stack, { scope, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION });
    drivers.push(d);
    return d;
  };
  /**
   * The completion line of the acceptance at `scope` whose outcome is `outcome`, and its markers.
   * A limb expecting markers names how many, so the read waits for them too and the ORDER is what
   * its assertion decides, rather than when the stdio happened to arrive.
   */
  const acceptanceAt = async (scope: string, outcome: string, markersExpected = 0) => {
    const isDone = (l: DebugLine) => l.namespace === 'nebula-auth.worker.acceptMembership' && l.message === 'accepted'
      && l.data.scope === scope && l.data.outcome === outcome;
    const markersOf = (a: DebugLine[], op: unknown) => a.filter((l) => l.namespace === 'nebula.scope.teardown'
      && l.message === 'tearing down' && l.data.operationId === op);
    const all = await waitForDebugLines(stack, (a) => {
      const done = a.find(isDone);
      return !!done && markersOf(a, done.data.operationId).length >= markersExpected;
    }, `the acceptance at ${scope} answering ${outcome}, with ${markersExpected} markers`);
    const done = all.find(isDone)!;
    return { all, done, markers: markersOf(all, done.data.operationId) };
  };
  /** A chat holding one message, and a read that lists the chat's messages. */
  const postMessage = async (d: Driver, content: string) => {
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const posted = await d.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: content } },
      [messageId]: { op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID, value: { chat: chatId, content } },
    });
    assert.equal(posted.kind, 'committed', `the chat post must commit, got ${posted.kind}`);
    const read = async () => {
      using sub = d.client.resources.subscribeQuery(chatQuery(chatId));
      await sub.ready;
      return sub.resourceIds;
    };
    return { messageId, read };
  };

  try {
    // ── Another account, with a message in its chat, before the root's first Accept (limb 4) ────
    const other = await provisionAndLogin({ baseUrl: origin, scope: `${universe}o.app`, testToken });
    const otherChat = await postMessage(await driver(`${universe}o.app`, other), 'another account');

    // ── The superuser: the root's first Accept, on Home ─────────────────────────────────────────
    // No page sits at the root, so the superuser drives from the page of the account this limb
    // founds — before it exists, which no refresh checks.
    const rootCookie = await clickFor(await mailTo(SUPERUSER, () => requestMagicLink({ baseUrl: origin, email: SUPERUSER })), PLATFORM);
    await acceptMembership(origin, rootCookie, PLATFORM);
    const atRoot = await driver(universe, await refreshAccessToken(origin, { refreshToken: rootCookie, authScope: PLATFORM }, universe));

    // ── 1. Nothing enters a scope its founder has not accepted ──────────────────────────────────
    const founder = uniqueTestEmail();
    const founderLink = await mailTo(founder, () =>
      requestUniverseClaim({ baseUrl: origin, universe, appSlug: 'crm', email: founder }));
    const tenant = `${galaxy}.t1`;
    const tenantFounder = uniqueTestEmail();
    const pendingStar = await claimStar(tenant, tenantFounder);
    assert.equal(pendingStar.status, 400, 'a claim-star beneath a pending claim must be refused');
    assert.equal((await pendingStar.json() as { error_description: string }).error_description,
      `Parent galaxy "${galaxy}" does not exist`);
    const invitee = uniqueTestEmail();
    assert.equal(await refusal(atRoot.client.invite(galaxy, [{ email: invitee }])),
      `Cannot invite into "${galaxy}": its account's founder has not accepted it yet`);
    assert.equal(await refusal(atRoot.client.scopes.createGalaxy(universe, 'web')),
      `Parent universe "${universe}" does not exist`);

    // The founder accepts on the claim link's page; then every one of those succeeds (the positive
    // controls).
    const founderCookie = await clickFor(founderLink, universe);
    const tenantLink = await mailTo(tenantFounder, async () => {
      const resp = await claimStar(tenant, tenantFounder);
      assert.equal(resp.status, 200, 'the same claim-star must succeed once the universe is accepted');
    });
    const inviteLink = await mailTo(invitee, async () => {
      const summary = await atRoot.client.invite(galaxy, [{ email: invitee }]);
      assert.equal(summary.results[0]?.outcome, 'invited',
        `the same invite must land once the universe is accepted: ${JSON.stringify(summary)}`);
    }, inviteLinkOf);
    assert.deepEqual(await atRoot.client.scopes.createGalaxy(universe, 'web'), { instanceName: `${universe}.web` });

    // A tenant whose own founder is pending refuses an invite, until that founder accepts.
    const atUniverse = await driver(universe, await refreshAccessToken(origin, { refreshToken: founderCookie, authScope: universe }, universe));
    const pendingTenant = `${galaxy}.t2`;
    const pendingFounder = uniqueTestEmail();
    const pendingTenantLink = await mailTo(pendingFounder, () =>
      requestStarClaim({ baseUrl: origin, universeGalaxyStarId: pendingTenant, email: pendingFounder }));
    const guest = uniqueTestEmail();
    assert.equal(await refusal(atUniverse.client.invite(pendingTenant, [{ email: guest }])),
      `Cannot invite into "${pendingTenant}": its founder has not accepted it yet`);
    await clickFor(pendingTenantLink, pendingTenant);
    await atUniverse.client.invite(pendingTenant, [{ email: guest }]);
    console.error('  ✓ limb 1 — nothing entered a pending scope; each call succeeded once its founder accepted');

    // ── 2. A claim's first acceptance wipes the scopes it wrote, before it answers ──────────────
    if (observable) {
      const { done, markers } = await acceptanceAt(universe, 'accepted', 3);
      assert.deepEqual(markers.map((m) => [m.data.instanceName, m.data.binding, m.data.cause]).sort(),
        [[universe, 'UNIVERSE', 'creation'], [galaxy, 'GALAXY', 'creation'], [`${galaxy}.dev`, 'STAR', 'creation']].sort(),
        "the founder's first Accept must tear down the universe, its galaxy and its .dev Star");
      assert.ok(markers.every((m) => m.idx < done.idx), "the acceptance's completion must follow every marker it caused");
    } else {
      notObservable('2 (universe)');
    }
    await clickFor(tenantLink, tenant);
    if (observable) {
      const { markers } = await acceptanceAt(tenant, 'accepted', 1);
      assert.deepEqual(markers.map((m) => [m.data.instanceName, m.data.binding]), [[tenant, 'STAR']],
        "a claim-star's first Accept must tear down its Star alone");
    } else {
      notObservable('2 (claim-star)');
    }
    console.error('  ✓ limb 2 — each first acceptance wiped the scopes its claim wrote, before answering');

    // ── 3. A second Accept tears nothing down, and the message posted between survives ─────────
    const atGalaxy = await driver(galaxy, await refreshAccessToken(origin, { refreshToken: founderCookie, authScope: universe }, galaxy));
    const founderChat = await postMessage(atGalaxy, 'before the second Accept');
    assert.equal((await postAccept(universe, founderCookie)).status, 200, 'a second Accept must answer 200');
    if (observable) {
      const { markers } = await acceptanceAt(universe, 'already-accepted');
      assert.equal(markers.length, 0, 'a second Accept must tear nothing down');
    } else {
      notObservable('3 (markers)');
    }
    assert.deepEqual(await founderChat.read(), [founderChat.messageId], 'the message must survive a second Accept');
    console.error('  ✓ limb 3 — a second Accept tore nothing down; the message survived');

    // ── 4. Neither the root's first Accept nor an invitee's tears anything down ─────────────────
    if (observable) {
      assert.equal((await acceptanceAt(PLATFORM, 'accepted')).markers.length, 0,
        "the root's first Accept must tear nothing down");
    } else {
      notObservable('4 (root markers)');
    }
    assert.deepEqual(await otherChat.read(), [otherChat.messageId], "another account's chat must survive the root's Accept");
    await clickFor(inviteLink, galaxy);
    if (observable) {
      assert.equal((await acceptanceAt(galaxy, 'accepted')).markers.length, 0,
        "an invitee's first Accept must tear nothing down");
    } else {
      notObservable('4 (invitee markers)');
    }
    assert.deepEqual(await founderChat.read(), [founderChat.messageId], "the invited app's chat must survive the invitee's Accept");
    console.error("  ✓ limb 4 — the root's and an invitee's first Accept tore nothing down; both chats survived");

    // ── 5. Every acceptance leaves its record ──────────────────────────────────────────────────
    const founderSub = atUniverse.sub;
    if (observable) {
      const { all, done } = await acceptanceAt(universe, 'accepted');
      const record = all.find((l) => l.namespace === 'nebula-auth.Registry.identity.membershipAccepted'
        && l.data.operationId === done.data.operationId);
      assert.ok(record, "the founder's acceptance left no record");
      assert.equal(record.data.credential, 'link', "the acceptance record must name its credential, the link's");
      assert.equal(record.data.email, founder, 'the acceptance record must name the address');
      assert.deepEqual(record.data.accepted, [founderSub], 'the acceptance record must name the sub accepted');
      assert.deepEqual([...record.data.teardown].sort(), [universe, galaxy, `${galaxy}.dev`].sort(),
        'the acceptance record must name the scopes it handed to teardown');
      assert.ok(!('actingToken' in record.data), 'an acceptance presents no token, so its record names no actor');
      console.error('  ✓ limb 5 — the acceptance recorded credential, address, sub and teardown, with no actor');
    } else {
      notObservable('5');
    }

    // ── 6. A claim and a consume each leave their record ───────────────────────────────────────
    const newcomer = uniqueTestEmail();
    const ticketUniverse = `${universe}t`;
    const proved = await consumeLink(await mailTo(newcomer, () => requestMagicLink({ baseUrl: origin, email: newcomer })));
    const ticket = setCookieHeaders(proved).map((c) => new RegExp(`^${SIGNUP_TICKET_COOKIE}=([^;]+)`).exec(c)?.[1]).find(Boolean);
    assert.ok(ticket, 'a new address must be handed a signup ticket');
    const signedUp = await fetch(`${origin}/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}` },
      body: JSON.stringify({ slug: ticketUniverse, appSlug: 'notes' }),
    });
    assert.equal(signedUp.status, 200, 'the ticket-backed claim must succeed');
    if (observable) {
      const all = await waitForDebugLines(stack, (a) => a.some((l) => l.namespace === 'nebula-auth.Registry.claimUniverseWithTicket'
        && l.data.universe === ticketUniverse), 'the ticket-backed claim record');
      const scopesOf = (l: DebugLine | undefined) => [l?.data.universe, l?.data.galaxy, l?.data.devStar];
      const claim = all.find((l) => l.namespace === 'nebula-auth.Registry.claimUniverse' && l.data.universe === universe);
      assert.equal(claim?.data.email, founder, 'the claim record must name the address');
      assert.equal(claim?.data.sub, founderSub, 'the claim record must name the membership it opened');
      assert.deepEqual(scopesOf(claim), [universe, galaxy, `${galaxy}.dev`], 'the claim record must name all three scopes');
      const ticketClaim = all.find((l) => l.namespace === 'nebula-auth.Registry.claimUniverseWithTicket' && l.data.universe === ticketUniverse);
      assert.equal(ticketClaim?.data.email, newcomer, 'the ticket-backed claim record must name the address');
      assert.ok(ticketClaim?.data.sub, 'the ticket-backed claim record must name the membership it opened');
      assert.deepEqual(scopesOf(ticketClaim), [ticketUniverse, `${ticketUniverse}.notes`, `${ticketUniverse}.notes.dev`],
        'the ticket-backed claim record must name all three scopes');
      const starClaim = all.find((l) => l.namespace === 'nebula-auth.Registry.claimStar' && l.data.star === tenant);
      assert.equal(starClaim?.data.email, tenantFounder, 'the claim-star record must name the address and the Star');
      assert.ok(starClaim?.data.sub, 'the claim-star record must name the sub it minted');
      const consume = all.find((l) => l.namespace === 'nebula-auth.Registry.login.established' && l.data.email === founder);
      assert.ok(consume, "the founder's consume left no record");
      assert.ok(consume.data.sessions.some((s: { sub: string }) => s.sub === founderSub), 'the consume record must name the sessions it opened');
      assert.ok(!('actingToken' in consume.data), 'a consume presents no token, so its record names no actor');
      console.error('  ✓ limb 6 — each claim, the ticket-backed one included, and the consume left its record');
    } else {
      notObservable('6');
    }

    // ── 7. A superseded claim leaves nothing behind ────────────────────────────────────────────
    const changer = uniqueTestEmail();
    const retired = `${universe}x`;
    const kept = `${universe}y`;
    await mailTo(changer, () => requestUniverseClaim({ baseUrl: origin, universe: retired, appSlug: 'crm', email: changer }));
    const keptLink = await mailTo(changer, () => requestUniverseClaim({ baseUrl: origin, universe: kept, appSlug: 'crm', email: changer }));
    await clickFor(keptLink, kept);
    if (observable) {
      const all = await waitForDebugLines(stack, (a) => a.some((l) => l.namespace === 'nebula-auth.Registry.claim.converged'
        && l.data.keptScope === kept), 'the convergence record');
      const converged = all.find((l) => l.namespace === 'nebula-auth.Registry.claim.converged' && l.data.keptScope === kept)!;
      assert.deepEqual(converged.data.retired, [retired, `${retired}.crm`, `${retired}.crm.dev`],
        'the convergence record must name the retired claim\'s whole subtree');
    } else {
      notObservable('7 (record)');
    }
    assert.notEqual(await requestUniverseClaim({ baseUrl: origin, universe: retired, appSlug: 'crm', email: uniqueTestEmail() }),
      null, 'the retired slug must be claimable again with the same first app');
    console.error('  ✓ limb 7 — the superseded claim\'s subtree is gone and its slug claimable again');
  } finally {
    for (const d of drivers) d.dispose();
  }
}
