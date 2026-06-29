/**
 * DevContainer entrypoint gate (Phase 3.5a — M2 + M3). Drives the REAL Nebula
 * entrypoint via `Browser().fetch`, with
 * `DEV_CONTAINER` bound to an inert serving stub (`DevContainerServeStub`) — the real
 * Container can't construct under vitest-pool-workers, and the gate only does an
 * identity check (`doNamespace === env.DEV_CONTAINER`), so an inert stand-in proves
 * routing faithfully.
 *
 *  - **M3** (serving-target switch): GET/HEAD to DEV_CONTAINER reaches the DO (the
 *    preview shell + vite assets); a non-GET is 405; a non-serving binding is 404.
 *  - **M2** (HMR-WS allow): a WebSocket upgrade to DEV_CONTAINER is allowed through;
 *    a WS upgrade to ANY other DO binding stays 501 (mesh WS terminates at the Gateway).
 *
 * Each is capable-of-failing (mutation-checks recorded inline). The real fetch()
 * 3-way branch + scope injection is tested in container-node/dev-container.test.ts.
 *
 * @see tasks/nebula-studio.md § DevContainer dev loop (M2/M3)
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import { uniqueGalaxyScope } from '../../test-helpers';

const ORIGIN = 'http://localhost';
const WS_HEADERS = { Upgrade: 'websocket', Connection: 'Upgrade' };

describe('DevContainer entrypoint gate — M3 (serving-target switch)', () => {
  it('GET to DEV_CONTAINER reaches the DO (the preview shell/asset serve)', async () => {
    const { dev } = uniqueGalaxyScope();
    // Capable-of-failing: dropping `|| doNamespace === env.DEV_CONTAINER` from the
    // entrypoint onBeforeRequest → this 404s instead of reaching the stub.
    const res = await new Browser().fetch(`${ORIGIN}/dev-container/${dev}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('DEV_CONTAINER_STUB');
  });

  it('HEAD to DEV_CONTAINER is in the allow-set (200)', async () => {
    const { dev } = uniqueGalaxyScope();
    const res = await new Browser().fetch(`${ORIGIN}/dev-container/${dev}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('a non-GET/HEAD to DEV_CONTAINER is 405', async () => {
    const { dev } = uniqueGalaxyScope();
    const res = await new Browser().fetch(`${ORIGIN}/dev-container/${dev}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('GET');
  });

  it('a GET to a non-serving binding (NEBULA_AUTH) is still 404 (gate not widened)', async () => {
    // The M3 widening adds ONLY DEV_CONTAINER — a non-serving binding stays 404.
    const res = await new Browser().fetch(`${ORIGIN}/nebula-auth/whatever/`);
    expect(res.status).toBe(404);
  });
});

describe('DevContainer entrypoint gate — M2 (HMR WebSocket allow)', () => {
  it('a WebSocket upgrade to DEV_CONTAINER is allowed through to the DO', async () => {
    const { dev } = uniqueGalaxyScope();
    // Capable-of-failing: removing `if (doNamespace === env.DEV_CONTAINER) return
    // undefined;` from the entrypoint onBeforeConnect → this 501s.
    const res = await new Browser().fetch(`${ORIGIN}/dev-container/${dev}/`, { headers: WS_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('DEV_CONTAINER_STUB WS');
  });

  it('a WebSocket upgrade to GALAXY is still 501 (HMR WS allow is DEV_CONTAINER-only)', async () => {
    const { galaxy } = uniqueGalaxyScope();
    const res = await new Browser().fetch(`${ORIGIN}/galaxy/${galaxy}/`, { headers: WS_HEADERS });
    expect(res.status).toBe(501);
  });

  it('a WebSocket upgrade to STAR is still 501', async () => {
    const { galaxy, starA } = uniqueGalaxyScope();
    const res = await new Browser().fetch(`${ORIGIN}/star/${starA}/`, { headers: WS_HEADERS });
    expect(res.status).toBe(501);
  });
});
