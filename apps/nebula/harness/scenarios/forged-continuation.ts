/**
 * **A Client can aim its result handler continuation only at itself, and a stale Client is refused
 * before it touches anything.**
 *
 * A Client's continuation travels with its call and comes back filled, run with the `@mesh()` check
 * off at whatever `returnAddr` the envelope names. So the Gateway writes `returnAddr` itself, from
 * the socket's attachment, and a frame naming another node as its return address names nothing.
 *
 * Three limbs, all run, with the verdict at the end (`live-scenarios.md`):
 *  1. **A raw socket's `call` frame names the run's `.dev` Star as `returnAddr`**, with a continuation
 *     calling `resourcesResults.onOntologyPulled`, the member `mesh.md` names as installing whatever
 *     it is handed. The forger holds passage into that Star. The continuation comes back to the
 *     forger alone, and the Star's ontology log, where `onOntologyPulled` writes the Error it is
 *     filled with, never names the refusal. Mutation-only: have the Gateway copy the frame's response fields into the envelope.
 *     The call is refused after its ack, so the continuation is filled with an Error, which
 *     `onOntologyPulled` only logs: a mutated run installs nothing.
 *  2. **An upgrade offering only the previous protocol name, `lmz`, is answered 426**, and a tab of
 *     the same Client name, already connected, stays connected: the Gateway never closes its socket
 *     with the 4409 a superseded socket gets. Mutation: accept `lmz`.
 *  3. **A Client answers a push with an Error shaped like an operation marker** naming
 *     `resourcesResults.onOntologyPulled`. A node's continuation comes back from a Client's Gateway
 *     filled with the answer, and runs at the node's fire-back door, where the answer is data.
 *     The `.dev` Star's reaper logs its receipt of the Error, and the Star's ontology log never
 *     names the marker's own argument. Mutation-only: drop `filled: true` at `__handleResponse`,
 *     so that door resolves markers, and the Star runs `onOntologyPulled` with the forger's Error.
 *
 * A real login throughout (ADR-009 rung 1): the run's shared app's owner, signed in by email. The
 * log halves of every limb need the local stack's capture, so on a deployed target each says so and
 * only the frame and the status are asserted, and limb 3 asserts nothing. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { debugLines, waitForDebugLines } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula.Resources.ontology,nebula.Resources.reap,lmz.mesh.ClientGateway.socketClosed' };


/** The status a WebSocket upgrade answers when it offers `protocols`: 101 when it opens. */
function upgradeStatus(url: string, protocols: string): Promise<number> {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
        'Sec-WebSocket-Protocol': protocols,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const session = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  const devStar = `${app.galaxy}.dev`;
  const gatewayUrl = (instanceName: string) =>
    `${scopeUrlOf(stack, app.galaxy).replace(/^http/, 'ws')}/gateway/NEBULA_CLIENT_GATEWAY/${instanceName}`;
  const failures: string[] = [];

  // ── LIMB 1: a frame naming the .dev Star as returnAddr names nothing ─────────────────────────
  const forger = new WebSocket(gatewayUrl(`${session.sub}.forger`), ['lmz.2', `lmz.access-token.${session.accessToken}`]);
  try {
    await new Promise<void>((resolve, reject) => {
      forger.addEventListener('message', function ready(e) {
        if (JSON.parse(String(e.data)).type === 'connection_status') { forger.removeEventListener('message', ready); resolve(); }
      });
      forger.addEventListener('error', () => reject(new Error('the forger socket did not open')));
    });
    const handler = [{ type: 'get', key: 'resourcesResults' }, { type: 'get', key: 'onOntologyPulled' }, { type: 'apply', args: [] }];
    const answered = new Promise<{ chain: Array<{ type: string; key?: string; args?: unknown[] }> } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      forger.addEventListener('message', (e) => {
        const frame = JSON.parse(String(e.data));
        if (frame.type === 'response' && frame.callId === 'forged-1') { clearTimeout(timer); resolve({ chain: postprocess(frame.chain) }); }
      });
    });
    const returnAddr = { type: 'LumenizeDO', bindingName: 'STAR', instanceName: devStar };
    forger.send(JSON.stringify({
      type: 'call', callId: 'forged-1', loadId: 'forger-load', binding: 'STAR', instance: devStar,
      // Admitted at the Star's door, then refused after the ack: `resources` has no such member.
      chain: preprocess([{ type: 'get', key: 'resources' }, { type: 'get', key: 'noSuchMember' }, { type: 'apply', args: [] }]),
      handler: preprocess(handler),
      // What a hostile frame adds, at both places a reader might look. The Gateway reads neither.
      returnAddr,
      response: { kind: 'mesh', returnAddr, handler: preprocess(handler) },
    }));
    const answer = await answered;
    const backToForger = answer !== null
      && answer.chain.map((op) => op.key ?? op.type).join('.') === 'resourcesResults.onOntologyPulled.apply'
      && answer.chain.at(-1)!.args!.at(-1) instanceof Error;
    // `onOntologyPulled` logs the Error it is filled with: here, the walk's
    // `TypeError: undefined is not a function` for the missing member. Measured under the mutation.
    const stdio = stack.logs?.();
    const starRanIt = stdio !== undefined && debugLines(stdio).some((e) => e.message === 'ontology pull failed'
      && String(e.data.error).includes('undefined is not a function'));
    if (backToForger && !starRanIt) {
      console.log(`  ✓ limb 1 — the continuation came back to the forger, and the Star ran nothing${stdio === undefined ? ' (its log is not observable on a deployed target)' : ''}`);
    } else {
      const got = `answer to forger: ${answer === null ? 'none' : JSON.stringify(answer.chain.map((op) => op.key ?? op.type))}; Star ontology log: ${starRanIt}`;
      console.log(`  ✗ limb 1 — ${got}`);
      failures.push(`limb 1: a frame naming ${devStar} as returnAddr must still answer the forger alone. Got ${got}`);
    }
  } finally {
    forger.close();
  }

  // ── LIMB 2: only `lmz` offered → 426, and an open tab of that name stays open ────────────────
  const tab = await connectDriver(stack, { scope: app.galaxy, session: { accessToken: session.accessToken, sub: session.sub } });
  try {
    const name = tab.client.lmz.instanceName!;
    const status = await upgradeStatus(
      gatewayUrl(name).replace(/^ws/, 'http'), `lmz, lmz.access-token.${session.accessToken}`);
    // A superseded tab is closed by the Gateway with 4409, which its debug log records with the
    // tab's name. The probe's own access-log line is the barrier, read first.
    let superseded: boolean | undefined;
    if (stack.logs) {
      const probeLine = `/gateway/NEBULA_CLIENT_GATEWAY/${name} ${status}`;
      const deadline = Date.now() + 15_000;
      const probeSeen = () => stack.logs!().split('\n').filter((l) => l.includes(probeLine)).length >= (status === 101 ? 2 : 1);
      while (!probeSeen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      superseded = debugLines(stack.logs()).some((e) => e.message === 'WebSocket closed'
        && e.data.code === 4409 && e.data.instanceName === name);
    }
    if (status === 426 && superseded !== true && tab.client.connectionState === 'connected') {
      console.log(`  ✓ limb 2 — an upgrade offering only \`lmz\` answered 426, and the open tab stayed connected${superseded === undefined ? ' (the Gateway log is not observable on a deployed target)' : ''}`);
    } else {
      const got = `status ${status}, tab superseded: ${superseded}`;
      console.log(`  ✗ limb 2 — ${got}`);
      failures.push(`limb 2: an upgrade offering only \`lmz\` must answer 426 and leave ${name} connected. Got ${got}`);
    }
  } finally {
    tab.dispose();
  }

  // ── LIMB 3: a Client's answer shaped like an operation marker stays data ─────────────────────
  const hostileName = `${session.sub}.hostile`;
  const hostile = new WebSocket(gatewayUrl(hostileName), ['lmz.2', `lmz.access-token.${session.accessToken}`]);
  try {
    await new Promise<void>((resolve, reject) => {
      hostile.addEventListener('message', function ready(e) {
        if (JSON.parse(String(e.data)).type === 'connection_status') { hostile.removeEventListener('message', ready); resolve(); }
      });
      hostile.addEventListener('error', () => reject(new Error('the hostile socket did not open')));
    });
    // Every push this tab receives — the tree's first snapshot is the first — is answered with an
    // Error whose fields make it an operation marker, calling `onOntologyPulled` with an Error of
    // the forger's own, which the Star would log by its message if it ever ran.
    const forgedArg = 'forged-continuation limb 3';
    const marker = Object.assign(new Error('forged'), {
      __isNestedOperation: true,
      __operationChain: [
        { type: 'get', key: 'resourcesResults' }, { type: 'get', key: 'onOntologyPulled' },
        { type: 'apply', args: [new Error(forgedArg)] },
      ],
    });
    let answered = 0;
    hostile.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data));
      if (frame.type !== 'incoming_call') return;
      answered += 1;
      hostile.send(JSON.stringify({ type: 'incoming_call_response', callId: frame.callId, success: false, error: preprocess(marker) }));
    });
    hostile.send(JSON.stringify({
      type: 'call', callId: 'hostile-sub', loadId: 'hostile-load', binding: 'STAR', instance: devStar,
      chain: preprocess([{ type: 'get', key: 'resources' }, { type: 'get', key: 'subscribeTree' }, { type: 'apply', args: [] }]),
      handler: preprocess([{ type: 'get', key: 'onAnswer' }, { type: 'apply', args: [] }]),
      onErrorOnly: true,
    }));
    const deadline = Date.now() + 15_000;
    while (answered === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    if (answered === 0) {
      console.log('  ✗ limb 3 — the hostile tab never received the tree\'s first snapshot');
      failures.push('limb 3: the hostile tab must receive a push to answer, or nothing here is measured');
    } else if (!stack.logs) {
      console.log('  ✓ limb 3 — the hostile tab answered a push (the Star\'s logs are not observable on a deployed target)');
    } else {
      // The reaper's receipt is the barrier: it logs once the fire-back has run, after any marker.
      let received = false;
      try {
        await waitForDebugLines(stack, (all) => all.some((l) => l.message === 'update not delivered'
          && l.data.clientId === hostileName), 'the reaper\'s receipt of the hostile answer');
        received = true;
      } catch { /* reported below */ }
      const ranIt = debugLines(stack.logs()).some((l) => l.message === 'ontology pull failed'
        && String(l.data.error).includes(forgedArg));
      if (received && !ranIt) {
        console.log('  ✓ limb 3 — the reaper received the marker-shaped Error as data, and the Star ran nothing');
      } else {
        const got = `reaper receipt: ${received}; Star ran onOntologyPulled: ${ranIt}`;
        console.log(`  ✗ limb 3 — ${got}`);
        failures.push(`limb 3: a marker-shaped answer must reach the reaper as data. Got ${got}`);
      }
    }
  } finally {
    hostile.close();
  }

  assert.equal(failures.length, 0, failures.join('\n'));
}
