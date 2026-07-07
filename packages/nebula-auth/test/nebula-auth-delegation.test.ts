/**
 * Delegation tests — actors, delegated tokens.
 *
 * Each test uses a unique instanceName to get an isolated DO.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/auth';
import { fullLogin, adminRequest, url } from './test-helpers';
import { createNebulaTestToken } from '../src/create-nebula-test-token';
import { matchAccess } from '../src/parse-id';

describe('Delegation', () => {

  // ============================================
  // Actor Management
  // ============================================

  describe('POST /subject/:sub/actors', () => {
    it('adds an authorized actor', async () => {
      const inst = 'deleg-add-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, `subject/${user.parsed.sub}/actors`, admin.access_token, {
        method: 'POST',
        body: { actorSub: admin.parsed.sub },
      });
      expect(resp.status).toBe(200);
    });

    it('rejects adding actor for nonexistent principal', async () => {
      const inst = 'deleg-add-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, `subject/nonexistent/actors`, admin.access_token, {
        method: 'POST',
        body: { actorSub: admin.parsed.sub },
      });
      expect(resp.status).toBe(404);
    });

    it('rejects adding nonexistent actor', async () => {
      const inst = 'deleg-add-3';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, `subject/${user.parsed.sub}/actors`, admin.access_token, {
        method: 'POST',
        body: { actorSub: 'nonexistent-uuid' },
      });
      expect(resp.status).toBe(400);
    });
  });

  // ============================================
  // Remove Actor
  // ============================================

  describe('DELETE /subject/:sub/actors/:actorId', () => {
    it('removes an authorized actor', async () => {
      const inst = 'deleg-rm-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      // Add actor
      await adminRequest(stub, inst, `subject/${user.parsed.sub}/actors`, admin.access_token, {
        method: 'POST',
        body: { actorSub: admin.parsed.sub },
      });

      // Remove actor
      const resp = await adminRequest(stub, inst, `subject/${user.parsed.sub}/actors/${admin.parsed.sub}`, admin.access_token, {
        method: 'DELETE',
      });
      expect(resp.status).toBe(200);
    });
  });

  // ============================================
  // Delegated Token
  // ============================================

  describe('POST /delegated-token', () => {
    it('admin can issue delegated token for any subject', async () => {
      const inst = 'deleg-token-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, 'delegated-token', admin.access_token, {
        method: 'POST',
        body: { actFor: user.parsed.sub, activeScope: inst },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.access_token).toBeDefined();

      const parsed = parseJwtUnsafe(body.access_token)!.payload as any;
      expect(parsed.sub).toBe(user.parsed.sub);
      expect(parsed.act).toBeDefined();
      expect(parsed.act.sub).toBe(admin.parsed.sub);
    });

    it('authorized actor can issue delegated token', async () => {
      const inst = 'deleg-token-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');
      const actor = await fullLogin(stub, inst, 'actor@example.com');

      // Approve actor
      await adminRequest(stub, inst, `subject/${actor.parsed.sub}`, admin.access_token, {
        method: 'PATCH',
        body: { adminApproved: true },
      });

      // Add actor authorization
      await adminRequest(stub, inst, `subject/${user.parsed.sub}/actors`, admin.access_token, {
        method: 'POST',
        body: { actorSub: actor.parsed.sub },
      });

      // Actor requests delegated token — needs a fresh JWT after approval
      const actorRefresh = await fullLogin(stub, inst, 'actor@example.com');

      const resp = await adminRequest(stub, inst, 'delegated-token', actorRefresh.access_token, {
        method: 'POST',
        body: { actFor: user.parsed.sub, activeScope: inst },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      const parsed = parseJwtUnsafe(body.access_token)!.payload as any;
      expect(parsed.sub).toBe(user.parsed.sub);
      expect(parsed.act.sub).toBe(actorRefresh.parsed.sub);
    });

    it('unauthorized non-admin cannot delegate', async () => {
      const inst = 'deleg-token-3';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');
      const other = await fullLogin(stub, inst, 'other@example.com');

      // Approve other so they can at least authenticate
      await adminRequest(stub, inst, `subject/${other.parsed.sub}`, admin.access_token, {
        method: 'PATCH',
        body: { adminApproved: true },
      });
      const otherRefresh = await fullLogin(stub, inst, 'other@example.com');

      const resp = await adminRequest(stub, inst, 'delegated-token', otherRefresh.access_token, {
        method: 'POST',
        body: { actFor: user.parsed.sub, activeScope: inst },
      });
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Escalation fix — scope-bounded mint (NOW-1). Every test above is same-scope
  // (activeScope === instanceName), where the caller-pattern gate and the instance-pattern gate
  // return identical results — so they cannot catch the escalation. These exercise cross-scope.
  // ============================================
  describe('POST /delegated-token — scope-bounded mint (escalation fix)', () => {
    it('rejects refresh-cookie auth — a scope-bounded mint requires a Bearer access token (B1)', async () => {
      const inst = 'esc-cookie';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      // Cookie-only (no Authorization header): the refresh cookie carries no `access` claim, so the
      // mint cannot derive the caller's reach. Must be rejected rather than fall back to the instance.
      const resp = await stub.fetch(new Request(url(inst, 'delegated-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': `refresh-token=${admin.refreshToken}` },
        body: JSON.stringify({ actFor: user.parsed.sub, activeScope: inst }),
      }));
      expect(resp.status).toBe(401);
    });

    it('binds the minted token to the REQUESTED scope, not the issuing instance (M3)', async () => {
      const inst = 'esc-narrow'; // universe-tier; founder pattern is `esc-narrow.*`
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      const childScope = `${inst}.crm`; // a galaxy within the universe
      const resp = await adminRequest(stub, inst, 'delegated-token', admin.access_token, {
        method: 'POST',
        body: { actFor: user.parsed.sub, activeScope: childScope },
      });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.aud).toBe(childScope);
      // Minted pattern is `buildAuthScopePattern(childScope)` = `esc-narrow.crm.*` — NOT the instance's
      // `esc-narrow.*` (the old mint). Reds against today's instance-derived pattern.
      expect(parsed.access.authScopePattern).toBe(`${childScope}.*`);
      // Positive: the galaxy-scoped delegated token still reaches a child Star (pattern, not bare id).
      expect(matchAccess(parsed.access.authScopePattern, `${childScope}.tenant`)).toBe(true);
    });

    it('carries the CALLER admin bit, not the target — a non-admin actor acting-for an admin gets no admin', async () => {
      const inst = 'esc-adminflag';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com'); // founder admin
      const target = await fullLogin(stub, inst, 'target@example.com');
      const actor = await fullLogin(stub, inst, 'actor@example.com'); // non-admin

      // Make the TARGET an admin — the OLD mint copied `target.isAdmin` into the delegated token.
      await stub.fetch(new Request(url(inst, 'test/set-subject-data'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'target@example.com', isAdmin: true }),
      }));
      // Approve the (non-admin) actor so it can authenticate, and authorize it to act for the target.
      await adminRequest(stub, inst, `subject/${actor.parsed.sub}`, admin.access_token, {
        method: 'PATCH', body: { adminApproved: true },
      });
      await adminRequest(stub, inst, `subject/${target.parsed.sub}/actors`, admin.access_token, {
        method: 'POST', body: { actorSub: actor.parsed.sub },
      });
      const actorFresh = await fullLogin(stub, inst, 'actor@example.com');

      const resp = await adminRequest(stub, inst, 'delegated-token', actorFresh.access_token, {
        method: 'POST', body: { actFor: target.parsed.sub, activeScope: inst },
      });
      expect(resp.status).toBe(200);
      const parsed = parseJwtUnsafe((await resp.json() as any).access_token)!.payload as any;
      expect(parsed.sub).toBe(target.parsed.sub);
      // Escalation fix: the minted token's admin bit is the CALLER's (non-admin → omitted), not the
      // target's. Reds against today's `subject.isAdmin` pass-through (`access.admin === true`).
      expect(parsed.access.admin).toBeUndefined();
    });

    it('rejects an activeScope the CALLER cannot reach even when the instance can (403)', async () => {
      const inst = 'esc-cross'; // universe DO; instance pattern `esc-cross.*`
      const stub = env.NEBULA_AUTH.getByName(inst);
      const narrow = await fullLogin(stub, inst, 'narrow@example.com'); // local subject at this DO
      const user = await fullLogin(stub, inst, 'user@example.com');

      // A token for that same subject whose reach is only a GALAXY subtree (`esc-cross.gal.*`).
      // The local-subject branch of #verifyBearerToken admits it (sub is local) and surfaces its
      // narrower pattern — the exact shape the instance-only check missed.
      const mintNarrow = createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        email: 'narrow@example.com',
        sub: narrow.parsed.sub,
        instanceName: `${inst}.gal`,
        activeScope: `${inst}.gal`,
        isAdmin: true,
      });
      const { access_token: narrowToken } = await mintNarrow();

      // Request a SIBLING galaxy — within the universe DO's reach, but NOT the caller's `esc-cross.gal.*`.
      const resp = await adminRequest(stub, inst, 'delegated-token', narrowToken, {
        method: 'POST', body: { actFor: user.parsed.sub, activeScope: `${inst}.other` },
      });
      // New: caller-reach gate → 403. Old (instance-only gate): would proceed to mint. Capable-of-failing.
      expect(resp.status).toBe(403);
    });

    it('rejects a caller presenting an already-delegated (act-bearing) token — root identity only', async () => {
      const inst = 'esc-chained';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'user@example.com');

      // A token that already carries an `act` chain — what a delegated token looks like. Re-presenting
      // it to /delegated-token would record the token's top-level `sub` (a principal) as the actor.
      const mintDelegated = createNebulaTestToken({
        privateKey: env.JWT_PRIVATE_KEY_BLUE,
        email: 'admin@example.com',
        sub: admin.parsed.sub,
        instanceName: inst,
        activeScope: inst,
        isAdmin: true,
        actorSub: user.parsed.sub, // → act: { sub: user }
      });
      const { access_token: actBearing } = await mintDelegated();

      const resp = await adminRequest(stub, inst, 'delegated-token', actBearing, {
        method: 'POST', body: { actFor: user.parsed.sub, activeScope: inst },
      });
      // New: root-identity guard → 403. Old (no guard): the act-bearing token is admitted and mints. Capable-of-failing.
      expect(resp.status).toBe(403);
    });
  });
});
