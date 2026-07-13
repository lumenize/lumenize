/**
 * Delegation — the `/delegated-token` ADMIN branch (the `AuthorizedActor` non-admin path is CUT by
 * tasks/nebula-auth-surrogate-sub.md). Driven through the Worker; the scope-bounded / caller-reach /
 * root-identity escalation guards (security.md § Delegation, mint-side) are the load-bearing cases.
 *
 * The cross-scope tests mint narrower tokens via `createNebulaTestToken` (ADR-009 rung 3, justified —
 * this file is testing.md's canonical cross-scope-fixture example): a same-scope fixture cannot tell
 * "bind to the caller's scope" from "bind to the issuing scope".
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/auth';
import { foundUniverse, inviteAndLogin, adminRequest, url } from './test-helpers';
import { createNebulaTestToken } from '../src/create-nebula-test-token';
import { matchAccess } from '../src/parse-id';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

describe('Delegation — /delegated-token (admin branch only)', () => {
  it('an admin can issue a delegated token for a member — sub=target, act.sub=caller, admin bit = CALLER', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com'); // non-admin member

    const resp = await adminRequest(SELF, u, 'delegated-token', admin.access_token, {
      method: 'POST', body: { actFor: user.parsed.sub, activeScope: u },
    });
    expect(resp.status).toBe(200);
    const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
    expect(parsed.sub).toBe(user.parsed.sub);       // acted-for principal
    expect(parsed.act.sub).toBe(admin.parsed.sub);  // the real actor
    expect(parsed.access.admin).toBe(true);         // the CALLER's admin bit, though `user` is non-admin
  });

  it('a non-admin caller cannot delegate (403) — the authorized-actor path is gone', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const scope = `${u}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    const other = await inviteAndLogin(SELF, scope, admin.access_token, 'other@example.com');

    const resp = await adminRequest(SELF, scope, 'delegated-token', member.access_token, {
      method: 'POST', body: { actFor: other.parsed.sub, activeScope: scope },
    });
    expect(resp.status).toBe(403);
  });

  it('404 when acting for a subject that does not exist', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const resp = await adminRequest(SELF, u, 'delegated-token', admin.access_token, {
      method: 'POST', body: { actFor: 'no-such-sub', activeScope: u },
    });
    expect(resp.status).toBe(404);
  });

  describe('scope-bounded / escalation guards', () => {
    it('rejects cookie-only auth — a scope-bounded mint requires a Bearer access token (401)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');
      const resp = await SELF.fetch(new Request(url(u, 'delegated-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${admin.refreshToken}` },
        body: JSON.stringify({ actFor: user.parsed.sub, activeScope: u }),
      }));
      expect(resp.status).toBe(401);
    });

    it('binds the minted token to the REQUESTED scope, not the caller pattern (M3)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com'); // pattern `${u}.*`
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const childScope = `${u}.crm`; // a galaxy within the universe
      const resp = await adminRequest(SELF, u, 'delegated-token', admin.access_token, {
        method: 'POST', body: { actFor: user.parsed.sub, activeScope: childScope },
      });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.aud).toBe(childScope);
      expect(parsed.access.authScopePattern).toBe(`${childScope}.*`); // NOT the caller's `${u}.*`
      expect(matchAccess(parsed.access.authScopePattern, `${childScope}.tenant`)).toBe(true);
    });

    it('rejects an activeScope the CALLER cannot reach (403) — cross-scope, caller-reach gate', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      // A galaxy-scoped admin token (`${u}.gal.*`) — its reach does NOT cover a sibling galaxy.
      const narrow = await createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: `${u}.gal`,
        activeScope: `${u}.gal`,
        isAdmin: true,
      })();

      const resp = await adminRequest(SELF, `${u}.gal`, 'delegated-token', narrow.access_token, {
        method: 'POST', body: { actFor: user.parsed.sub, activeScope: `${u}.other` }, // sibling galaxy
      });
      expect(resp.status).toBe(403);
    });

    it('rejects an already-delegated (act-bearing) caller token — root identity only (403)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const user = await inviteAndLogin(SELF, u, admin.access_token, 'user@example.com');

      const actBearing = await createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        sub: admin.parsed.sub,
        instanceName: u,
        activeScope: u,
        isAdmin: true,
        actorSub: user.parsed.sub, // → act: { sub: user } — an already-delegated token
      })();

      const resp = await adminRequest(SELF, u, 'delegated-token', actBearing.access_token, {
        method: 'POST', body: { actFor: user.parsed.sub, activeScope: u },
      });
      expect(resp.status).toBe(403);
    });
  });
});
