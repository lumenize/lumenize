/**
 * **A session survives its token lapsing, through the platform host's refresh — over a REAL wait.**
 *
 * A browser's session is its cookies on the platform host; its access token is a fifteen-minute
 * credential the page renews from them. This scenario holds a real login's cookies in the Browser
 * shim, connects a client on a galaxy's own host, makes a call, then waits out that token's
 * lifetime with the socket open, and makes another. Nothing short of a real lapse proves a session
 * survives one (`calibration.md` §13): a token born expired would prove only that the renewal path
 * runs. A local boot shortens the lifetime to two minutes through `NEBULA_AUTH_ACCESS_TOKEN_TTL`,
 * which may only shorten it; the lapse is just as real, and the mechanism the same as at fifteen.
 *
 * One limb, isolated (`live.md`):
 *
 *  1. **The call after the lapse lands, on a token the platform host renewed.** The first token is
 *     past its `exp`; the client renewed with a refresh from the galaxy's page — `Origin` naming that
 *     host, the shim's cookies riding, no body — and the call succeeded. *Reds if the client reuses
 *     the lapsed token, which its host node refuses.*
 *
 * ⚠️ **Slow by design: about three minutes in either venue.** The test deploy sets the same var
 * (`scripts/test-deploy-config.mjs`). The wait is the test.
 *
 * `needsContainer = false` — auth and one mesh call.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { RECOMMENDED_MIN_TTL_SECONDS } from '@lumenize/nebula-auth/claims';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

/** The shortest lifetime the server mints without warning that a token is born nearly due. */
const LIFETIME = RECOMMENDED_MIN_TTL_SECONDS;
export const bootVars = { NEBULA_AUTH_ACCESS_TOKEN_TTL: String(LIFETIME) };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  // The run's shared app, whose owner signs in.
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const browser = new Browser();
  // A real login whose cookies land in the shim's jar, as a browser's do.
  const login = await provisionAndLogin({ baseUrl: stack.baseUrl, scope: galaxy, email: app.ownerEmail, testToken, fetchImpl: browser.fetch });

  const page = scopeUrlOf(stack, galaxy);
  const ctx = browser.context(page);
  const refreshes: Array<{ origin: string | null; cookie: boolean; body: boolean }> = [];
  const observed: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${stack.baseUrl}/auth/refresh-token`) {
      refreshes.push({ origin: page, cookie: true, body: (await request.clone().text()).length > 0 });
    }
    return ctx.fetch(input, init);
  };
  const client = new NebulaClient({
    baseUrl: page, platformOrigin: stack.baseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    // A host node accepts a client only under its own `sub` (mesh.md).
    instanceName: `${login.sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: observed, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
  });
  try {
    // A call made before the first token waits for it, so the first read is also the first refresh.
    const read = () => client.lmz.callAsync('GALAXY', galaxy, client.ctn<Galaxy>().getCurrentOntology());
    await read();
    const { exp: firstExp, iat } = client.claims as unknown as { exp: number; iat: number };
    const before = refreshes.length;
    assert.ok(before >= 1, 'the client must have got its first token from the platform host — the positive control');
    // Mutation: mint to the constant again, or deploy without the var, and the token lives fifteen
    // minutes → reds here.
    const lifetime = firstExp - iat;
    assert.equal(lifetime, LIFETIME, `the first token must live ${LIFETIME}s, the lifetime both venues mint`);

    const waitMs = (lifetime + 30) * 1000;
    console.error(`[session-survives-token-lapse] waiting ${waitMs / 1000}s for the token to lapse, socket open…`);
    await new Promise((r) => setTimeout(r, waitMs));
    assert.ok(firstExp < Math.floor(Date.now() / 1000), 'fixture guard: the first token must really be expired');

    await read();
    const secondExp = (client.claims as unknown as { exp: number }).exp;
    assert.ok(secondExp > firstExp, `the call after the lapse must ride a renewed token (exp ${firstExp} → ${secondExp})`);
    assert.ok(refreshes.length > before, 'the renewal must be a refresh at the platform host');
    assert.ok(refreshes.slice(before).every((r) => !r.body), 'the refresh sends no body — the page names nothing');
    console.error('  ✓ limb 1 — the call after a real lapse landed on a token the platform host renewed');
  } finally {
    try { client[Symbol.dispose](); } catch { /* already disposed */ }
    ctx.close();
  }
}
