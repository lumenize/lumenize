/**
 * **An answer meant for an earlier load of a Client is dropped by the Client that receives it.**
 *
 * A Client's answer is delivered to whatever socket its name is on now, so a page that reloads, or
 * a new Client built on the same tab, can receive an answer its predecessor was waiting for. Every
 * call carries the `loadId` its Client minted when it was constructed, the answer echoes it, and a
 * Client drops one that is not its own.
 *
 * One limb and its positive control, with the verdict at the end (`live-scenarios.md`):
 *  1. **A scenario-local socket under a Client's name sends a call and closes at once**, so the
 *     answer, a refusal after the ack, waits out the gap in its host node's grace period. A second
 *     Client, built with the first one's `instanceName` in the same browser context, connects and
 *     receives it. It does not run it — the handler would log `late-answer was refused` — and its
 *     debug marker names the foreign `loadId`. Mutation: skip the `loadId` check.
 *  2. **Positive control:** an answer carrying the second Client's own `loadId` runs.
 *
 * A real login throughout (ADR-009 rung 1): the run's shared app's owner, signed in by email. The
 * markers are the Client's own, captured in this process. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { Browser } from '@lumenize/testing';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

const RAW_LOAD = 'earlier-load';

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const session = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  const instanceName = `${session.sub}.late-${crypto.randomUUID().slice(0, 8)}`;
  // On the app's own page, so the Galaxy hosts both Clients under one name.
  const gatewayUrl = `${scopeUrlOf(stack, app.galaxy).replace(/^http/, 'ws')}/gateway/${instanceName}`;
  // `UNIVERSE` at the Galaxy's name admits the call, then finds no member named `resources`: a
  // refusal after the ack, which reaches the Client by the fire-back road the grace period covers.
  const refusedAfterAck = [{ type: 'get', key: 'resources' }, { type: 'get', key: 'subscribeTree' }, { type: 'apply', args: [] }];

  const entries: Array<{ namespace: string; level: string; message: string; data?: Record<string, unknown> }> = [];
  setDebugSink((e) => entries.push(e as never));
  const failures: string[] = [];
  let second: NebulaClient | undefined;
  try {
    // ── The earlier load: send, and close before the answer can come back ────────────────────
    const earlier = new WebSocket(gatewayUrl, ['lmz.2', `lmz.access-token.${session.accessToken}`]);
    await new Promise<void>((resolve, reject) => {
      earlier.addEventListener('message', function ready(e) {
        if (JSON.parse(String(e.data)).type === 'connection_status') { earlier.removeEventListener('message', ready); resolve(); }
      });
      earlier.addEventListener('error', () => reject(new Error('the earlier socket did not open')));
    });
    earlier.send(JSON.stringify({
      type: 'call', callId: 'late-1', loadId: RAW_LOAD, binding: 'UNIVERSE', instance: app.galaxy,
      chain: preprocess(refusedAfterAck),
      handler: preprocess([{ type: 'get', key: 'logRefusal' }, { type: 'apply', args: ['late-answer'] }]),
      onErrorOnly: true,
    }));
    earlier.close();

    // ── The second Client, on the same name in the same browser context, receives it ─────────
    const ctx = new Browser().context(scopeUrlOf(stack, app.galaxy));
    second = new NebulaClient({
      baseUrl: scopeUrlOf(stack, app.galaxy),
      platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(app.galaxy),
      accessToken: session.accessToken,
      instanceName,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    // Its own call, to the same refusing target: the positive control.
    second.lmz.call('UNIVERSE', app.galaxy, (second.ctn() as any).resources.subscribeTree(),
      second.ctn().logRefusal('own-answer'), { onErrorOnly: true });

    const refused = (what: string) => entries.some((e) => e.level === 'warn' && e.message === `${what} was refused`);
    const dropped = () => entries.find((e) => e.message === 'dropped an answer meant for another load');
    const deadline = Date.now() + 15_000;
    while (!(dropped() && refused('own-answer')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // Settle a moment longer, so a wrongly-run late answer has time to log too.
    await new Promise((r) => setTimeout(r, 300));

    const marker = dropped();
    if (marker?.data?.loadId === RAW_LOAD && !refused('late-answer')) {
      console.log('  ✓ limb 1 — the second Client dropped the earlier load\'s answer, naming its loadId');
    } else {
      const got = `drop marker ${marker ? JSON.stringify(marker.data) : 'none'}; late answer ran: ${refused('late-answer')}`;
      console.log(`  ✗ limb 1 — ${got}`);
      failures.push(`limb 1: the answer to ${RAW_LOAD} must be dropped, not run. Got ${got}`);
    }
    if (refused('own-answer')) {
      console.log('  ✓ limb 2 — an answer carrying the second Client\'s own loadId runs');
    } else {
      console.log('  ✗ limb 2 — the second Client\'s own answer never ran');
      failures.push('limb 2: an answer carrying the Client\'s own loadId must run');
    }
  } finally {
    clearDebugSink();
    second?.[Symbol.dispose]();
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
