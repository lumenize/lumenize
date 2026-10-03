/**
 * The token routes that moved to `NebulaAuthFacade` are gone at both doors. The edge has no row for
 * them, and the Registry has no `fetch` case — a case left behind would trust the body's
 * `verifiedAccess`, which nothing upstream assigns any more, so a forged one would be believed.
 *
 * In-lane, since nothing reaches the Registry's `fetch` but the Worker's forward, and no running
 * system can address the stub directly.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { registryStub } from './test-helpers';

const RETIRED = ['expand-scope', 'create-galaxy', 'create-star', 'delete-scope', 'delete-scope-plan', 'mint-narrower-token'];

describe('the routes that moved to the facade answer 404', () => {
  // A row still in the table would reach its own steps and answer something else, a refusal or a
  // body error, so a 404 is what proves the row is absent.
  it.each(RETIRED)('the edge has no row for /auth/%s', async (path) => {
    const resp = await SELF.fetch(new Request(`http://localhost/auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(resp.status).toBe(404);
  });

  // The renamed predecessor of the mint route, and the scoped form of it, stay gone too.
  it.each(['delegated-token', 'mint-narrower-token'])('a scoped /auth/{u}/%s is no route either', async (path) => {
    const resp = await SELF.fetch(new Request(`http://localhost/auth/u-retired/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(resp.status).toBe(404);
  });

  // A forged platform-wide `verifiedAccess` is exactly what a surviving case would believe, since
  // the edge's injecting terminals are gone. Mutation: keep one case → it answers with its old
  // status (a 201, a 200, or a 403 from its own check) rather than 404.
  it.each(RETIRED)('the Registry has no fetch case for /auth/%s, whatever the body claims', async (path) => {
    const resp = await registryStub().fetch(new Request(`http://localhost/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verifiedAccess: { authScope: '_platform', scopeAdmin: true },
        callerSub: 'forged', target: 'acme', universeGalaxyId: 'acme.crm', universeGalaxyStarId: 'acme.crm.t',
      }),
    }));
    expect(resp.status).toBe(404);
  });
});
