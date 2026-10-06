/**
 * **`/gateway/` accepts one binding, and refuses every other before any Durable Object exists.**
 *
 * The Worker's `/gateway/*` route passes `routeDORequest` a `bindings` allow-list naming
 * `NEBULA_CLIENT_GATEWAY` alone. An upgrade naming another binding answers 404 as a binding the
 * Worker does not hold would, so no Star is constructed for it. A Star logs `nebula.Star.onStart`
 * with `ctx.id.name` at construction, before any identity is stamped, and that marker is the
 * witness.
 *
 * One limb, two positive controls:
 *  - **A Node WebSocket upgrade to `/gateway/STAR/{name}`, carrying a real token, answers 404, and
 *    no Star of that name starts.** Read from the stack's stdio after the upgrade's own access-log
 *    line, which wrangler prints after the Worker's output. Mutation: drop the option, and the
 *    marker appears.
 *  - **Positive controls:** the same token connects at `/gateway/NEBULA_CLIENT_GATEWAY/{sub}.{tabId}`,
 *    and a mesh call to that Star name starts it, so the marker does appear when a Star is made.
 *
 * Real login (ADR-009 rung 1). The stdio half needs the local stack's capture, so on a deployed
 * target it reports that it is not observable and only the 404 is asserted. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { asSharedOwner, sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula.Star.onStart' };

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

/** Wait until the captured stdio holds `line`, or report that it never did. */
async function stdioThrough(stack: DevStack, line: string): Promise<string | undefined> {
  let stdio = stack.logs?.();
  const deadline = Date.now() + 15_000;
  while (stdio !== undefined && !stdio.includes(line) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    stdio = stack.logs?.();
  }
  assert.ok(stdio === undefined || stdio.includes(line), `"${line}" never reached the captured stdio`);
  return stdio;
}

const startedMarker = (stdio: string, name: string): boolean =>
  stdio.split('\n').some((l) => l.includes('nebula.Star.onStart')) && stdio.includes(`"name": "${name}"`);

export async function run(stack: DevStack): Promise<void> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The run's shared account; the Star named here is never claimed, since its upgrade is refused.
  const app = await sharedApp(stack, readDevVar('TEST_TOKEN'));
  const universe = app.universe;
  const { session } = await asSharedOwner(stack, readDevVar('TEST_TOKEN'), universe);
  const starName = `${app.galaxy}.${testSlug('door')}`;

  // ── LIMB: another binding is refused at the door, and no Star of that name starts ─────────────
  const status = await upgradeStatus(`${origin}/gateway/STAR/${starName}`, session.accessToken);
  assert.equal(status, 404, `an upgrade to /gateway/STAR/${starName} answered ${status}, not 404`);
  const stdio = await stdioThrough(stack, `/gateway/STAR/${starName}`);
  if (stdio === undefined) {
    console.log('  · the Star-start half is not observable on a deployed target');
  } else {
    assert.ok(!startedMarker(stdio, starName), `a Star named ${starName} started for a refused upgrade`);
  }
  console.log('  ✓ limb — /gateway/STAR answered 404 and started no Star');

  // ── POSITIVE CONTROLS: the Gateway binding connects, and a Star does log when it starts ──────
  const driver = await connectDriver(stack, { scope: universe, session });
  try {
    console.log('  ✓ control — the same token connects at /gateway/NEBULA_CLIENT_GATEWAY/{sub}.{tabId}');
    if (stdio !== undefined) {
      try {
        await driver.client.lmz.callAsync('STAR', starName, (driver.client.ctn() as any).getStarConfig());
      } catch { /* refused or not: the Star was constructed to answer, which is all this needs */ }
      const deadline = Date.now() + 15_000;
      while (!startedMarker(stack.logs!(), starName) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(startedMarker(stack.logs!(), starName), `a mesh call to ${starName} logged no Star start`);
      console.log('  ✓ control — a mesh call to that Star starts it, and the marker appears');
    }
  } finally {
    driver.dispose();
  }
}
