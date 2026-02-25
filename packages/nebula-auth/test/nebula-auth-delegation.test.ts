/**
 * Delegation tests — actors, delegated tokens.
 *
 * Each test uses a unique instanceName to get an isolated DO.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/auth';
import { fullLogin, adminRequest } from './test-helpers';

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
        body: { actFor: user.parsed.sub },
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
        body: { actFor: user.parsed.sub },
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
        body: { actFor: user.parsed.sub },
      });
      expect(resp.status).toBe(403);
    });
  });
});
