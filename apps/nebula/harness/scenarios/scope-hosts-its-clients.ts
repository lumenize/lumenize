/**
 * **A scope's node hosts the Clients on its pages: an upgrade at `/gateway/{id}` on a scope's host
 * lands on the node that host spells, and every refusal happens before any node exists.**
 *
 * The Worker reads the scope from the hostname, so a Client names only its id: an upgrade at
 * `tenant1.crm.acme.lumenize.dev/gateway/alice.9f2c41aa` reaches the Star `acme.crm.tenant1`, which
 * holds the socket as `acme.crm.tenant1/alice.9f2c41aa`. Each tab here is a `NebulaClient` with
 * `hostFromHostname` set, the URL every page moves to once Nebula retires its Gateway.
 *
 * The Star `S` is one this scenario names and never claims until limb 5, so the owner's refresh on
 * its host mints a token whose `aud` is `S` while no Star of that name has been constructed. A Star
 * logs `nebula.Star.onStart` with `ctx.id.name` at construction, before any identity is stamped,
 * and that marker is the witness that a refused upgrade woke nothing.
 *
 * Five limbs, all run, the verdict at the end (`live-scenarios.md`):
 *  1. **Five refused upgrades, one operand each, and no Star `S` starts.** A token for another
 *     host, an id that does not start with the token's `sub`, no id, two segments, and
 *     `/gateway/STAR/{S}`, the binding-and-scope form a Client may no longer write. Mutation: drop
 *     each check in turn; its upgrade connects or is refused past routing, and the marker appears.
 *  2. **The same token with its own id connects, and `S` starts.** The positive control for limb 1,
 *     with the node's accept line naming `{S}/{id}`.
 *  3. **A push from a Profile and one from the Galaxy above reach the hosted tab,** though the
 *     Star's own `onBeforeCall` would refuse both chains: a Profile's names no scope, and a chain
 *     the Galaxy starts has no passage down into a Star. Mutation: run the Star's passage check on
 *     a call addressed to a Client it hosts; neither push arrives.
 *  4. **On a persona's host the same upgrade reaches the `.dev` Star.** Its accept line names
 *     `{galaxy}.dev/{persona id}`.
 *  5. **Founding `S` drops the tab without 4410, and the tab is told to re-subscribe; deleting `S`
 *     closes it with 4410.** Founding `S` tears down the object the tab is on, as any reset would,
 *     so the tab reconnects; deleting it tells the tab why. Mutation: drop the close before the
 *     wipe, or send 4410 whatever the cause.
 *
 * Real logins (ADR-009 rung 1): the run's shared app's owner, signed in by email, whose refresh
 * on each host mints that host's token. Limbs 1, 2 and 4 read the stack's stdio, which a deployed
 * target does not capture, and say so there. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Browser } from '@lumenize/testing';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken, refreshCookie, scopeOriginFrom, foundTenantStar } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { debugLines } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula.Star.onStart,lmz.mesh.ClientGateway.acceptUpgrade' };

/** A push or a reconnect crosses one process boundary. Past this it is a failure, not slowness. */
const WAIT_MS = 15_000;

/** The status a WebSocket upgrade answers: 101 when the socket opens, else the HTTP status. */
function upgradeStatus(url: string, token: string): Promise<number> {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
        'Sec-WebSocket-Protocol': `lmz.2, lmz.access-token.${token}`,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

/** Poll `check` until it holds or `WAIT_MS` passes; answers whether it held. */
async function eventually(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** A tab that records what reaches it: profile and tree pushes, re-subscribe reports, close codes. */
class HostedTab extends NebulaClient {
  nicknames: Array<string | undefined> = [];
  treePushes = 0;
  subscriptionRequired = 0;

  override handleProfileUpdate(profileId: string, result: any): void {
    if (result && !(result instanceof Error)) this.nicknames.push(result.value?.nickname);
    return super.handleProfileUpdate(profileId, result);
  }

  override handleOrgTreeUpdate(envelope: any): void {
    this.treePushes += 1;
    return super.handleOrgTreeUpdate(envelope);
  }

  override onSubscriptionRequired(): void {
    this.subscriptionRequired += 1;
    super.onSubscriptionRequired();
  }
}

/**
 * ⚠️ **An override is a NEW function, and `@mesh()` decorates the function value — so it does not
 * inherit.** Production spells the decorator; this file runs under `tsx`, which does not transform
 * TC39 decorators, so it sets the same flag the decorator sets on the two push handlers.
 */
for (const name of ['handleProfileUpdate', 'handleOrgTreeUpdate'] as const) {
  (HostedTab.prototype[name] as any)[Symbol.for('lumenize.mesh.callable')] = true;
}

/** A `WebSocket` that keeps the code of every close it sees, so a test can tell 4410 from a drop. */
function recordingWebSocket(codes: number[]): typeof WebSocket {
  return class RecordingWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('close', (event) => codes.push((event as CloseEvent).code));
    }
  };
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const star = `${app.galaxy}.${testSlug('host')}`;
  const owner = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  // The owner's universe cookie, refreshed on S's host: a token whose `aud` is S, which exists
  // while no Star S has been constructed.
  const onStar = await refreshAccessToken(origin, owner.session, star);
  const starHost = scopeUrlOf(stack, star).replace(/\/$/, '');

  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const stdio = (): string | undefined => stack.logs?.();
  // Each debug entry prints as a multi-line JSON block, so a line-by-line match never sees its
  // namespace beside its data: read the parsed entries.
  const entries = () => debugLines(stdio() ?? '');
  const starStarted = (): boolean =>
    entries().some((e) => e.namespace === 'nebula.Star.onStart' && e.data.name === star);
  const accepted = (instanceName: string): boolean => entries().some((e) =>
    e.namespace === 'lmz.mesh.ClientGateway.acceptUpgrade' && e.data.instanceName === instanceName);

  const drivers: Driver[] = [];
  const tabs: HostedTab[] = [];
  /** A hosted tab on `pageUrl`, as `sub`, recording into `codes`. */
  async function hostedTab(pageUrl: string, scope: string, accessToken: string, sub: string, codes: number[]): Promise<HostedTab> {
    const browser = new Browser();
    const ctx = browser.context(pageUrl);
    const tab = new HostedTab({
      baseUrl: pageUrl,
      platformOrigin: origin,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(scope),
      hostFromHostname: true,
      accessToken,
      instanceName: `${sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      WebSocket: recordingWebSocket(codes),
    });
    tabs.push(tab);
    assert.ok(await eventually(() => tab.connectionState === 'connected'),
      `a hosted tab on ${new URL(pageUrl).hostname} never connected (state=${tab.connectionState})`);
    return tab;
  }

  try {
    // ── LIMB 1: four refused upgrades, one operand each, and no Star S starts ───────────────────
    const refusals: Array<{ name: string; path: string; token: string; status: number }> = [
      { name: 'a token for another host', path: `/gateway/${onStar.sub}.t1`, token: owner.accessToken, status: 403 },
      { name: 'an id that is not the token\'s', path: `/gateway/${crypto.randomUUID()}.t1`, token: onStar.accessToken, status: 403 },
      { name: 'no id', path: '/gateway/', token: onStar.accessToken, status: 400 },
      { name: 'two segments', path: `/gateway/${onStar.sub}.t1/extra`, token: onStar.accessToken, status: 400 },
      { name: 'the binding-and-scope form', path: `/gateway/STAR/${star}`, token: onStar.accessToken, status: 400 },
    ];
    for (const r of refusals) {
      const status = await upgradeStatus(`${starHost}${r.path}`, r.token);
      limb(`limb 1 — ${r.name} is refused with ${r.status}`, status === r.status, `answered ${status}`);
    }
    if (stdio() === undefined) {
      console.log('  · whether a refused upgrade started a Star is not observable on a deployed target');
    } else {
      // wrangler logs each request after the Worker's own output, so once the last refusal's
      // request line is here, a Star start it caused would be too.
      const last = refusals.at(-1)!.path;
      assert.ok(await eventually(() => (stdio() ?? '').includes(last)), `"${last}" never reached the captured stdio`);
      limb('limb 1 — no refused upgrade started the Star', !starStarted(), `a Star named ${star} started`);
    }

    // ── LIMB 2: the same token with its own id connects, and S starts ──────────────────────────
    const codes: number[] = [];
    const tab = await hostedTab(starHost, star, onStar.accessToken, onStar.sub, codes);
    const tabName = `${star}/${tab.lmz.instanceName}`;
    if (stdio() !== undefined) {
      limb('limb 2 — the upgrade starts the Star', await eventually(starStarted), `no start was logged for ${star}`);
      limb('limb 2 — the Star holds the socket under {S}/{id}', await eventually(() => accepted(tabName)),
        `no accept line names ${tabName}`);
    }

    // ── LIMB 3: a push from a Profile and one from the Galaxy above reach the hosted tab ───────
    const profileId = tab.claims.profileId;
    using profile = tab.subscribeProfile(profileId);
    await profile.snapshot;
    const nickname = `hosted-${crypto.randomUUID().slice(0, 6)}`;
    await tab.updateMyProfile({ nickname });
    limb('limb 3 — a Profile\'s push reaches the hosted tab', await eventually(() => tab.nicknames.includes(nickname)),
      `the tab heard ${JSON.stringify(tab.nicknames)}`);

    await tab.lmz.callAsync('GALAXY', app.galaxy, tab.ctn<Galaxy>().resources.subscribeTree());
    assert.ok(await eventually(() => tab.treePushes > 0), 'the Galaxy\'s tree never reached the tab on subscribe');
    const before = tab.treePushes;
    const galaxyOwner = await connectDriver(stack, { scope: app.galaxy, session: { accessToken: owner.accessToken, sub: owner.sub } });
    drivers.push(galaxyOwner);
    await galaxyOwner.client.orgTree.createNode(crypto.randomUUID(), '00000000-0000-4000-8000-000000000000', testSlug('n'), 'Pushed');
    limb('limb 3 — the Galaxy\'s push reaches the hosted tab', await eventually(() => tab.treePushes > before),
      `the tab heard ${tab.treePushes - before} tree push(es) after the change`);

    // ── LIMB 4: on a persona's host the same upgrade reaches the `.dev` Star ───────────────────
    const devOrigin = scopeOriginFrom(origin, `${app.galaxy}.dev`);
    const personaUrl = devOrigin.replace('//dev.', '//manny--dev.');
    const personaRefresh = await fetch(`${origin}/auth/refresh-token`, {
      method: 'POST',
      headers: { Origin: personaUrl, Cookie: refreshCookie(owner.session.authScope, owner.session.refreshToken), 'Sec-Fetch-Site': 'same-site' },
    });
    assert.equal(personaRefresh.status, 200, `the persona's refresh answered ${personaRefresh.status}`);
    const persona = await personaRefresh.json() as { access_token: string; sub: string };
    const personaTab = await hostedTab(personaUrl, `${app.galaxy}.dev`, persona.access_token, persona.sub, []);
    const personaName = `${app.galaxy}.dev/${personaTab.lmz.instanceName}`;
    if (stdio() === undefined) {
      limb('limb 4 — a persona\'s tab connects on its host', personaTab.connectionState === 'connected', 'not connected');
    } else {
      limb('limb 4 — a persona\'s tab is held by the .dev Star', await eventually(() => accepted(personaName)),
        `no accept line names ${personaName}`);
    }

    // ── LIMB 5: founding S drops the tab without 4410; deleting S closes it with 4410 ──────────
    const required = tab.subscriptionRequired;
    const closes = codes.length;
    assert.notEqual(await foundTenantStar({ baseUrl: origin, star, testToken }), null, `${star} was already claimed`);
    const dropped = await eventually(() => codes.length > closes);
    limb('limb 5 — founding the Star drops the tab, without 4410', dropped && !codes.slice(closes).includes(4410),
      dropped ? `closed with ${JSON.stringify(codes.slice(closes))}` : 'the socket was never closed');
    limb('limb 5 — the tab reconnects and is told to re-subscribe',
      await eventually(() => tab.subscriptionRequired > required && tab.connectionState === 'connected'),
      `state=${tab.connectionState}, re-subscribe reports ${tab.subscriptionRequired - required}`);

    const beforeDelete = codes.length;
    await galaxyOwner.client.scopes.delete(star);
    const gone = await eventually(() => codes.slice(beforeDelete).includes(4410));
    limb('limb 5 — deleting the Star closes the tab with 4410', gone, `closed with ${JSON.stringify(codes.slice(beforeDelete))}`);
  } finally {
    for (const t of tabs) { try { t[Symbol.dispose](); } catch { /* already disposed */ } }
    for (const d of drivers) d.dispose();
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
