/**
 * Admin endpoint tests — subject CRUD, approve, bootstrap protection.
 *
 * Each test uses a unique instanceName to get an isolated DO.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { fullLogin, requestMagicLink, clickMagicLink, refreshAndParse, adminRequest, url } from './test-helpers';

describe('Admin Endpoints', () => {

  // ============================================
  // List Subjects
  // ============================================

  describe('GET /subjects', () => {
    it('lists all subjects', async () => {
      const inst = 'admin-list-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, 'subjects', access_token);
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subjects).toHaveLength(1);
      expect(body.subjects[0].email).toBe('admin@example.com');
    });

    it('filters by role=admin', async () => {
      const inst = 'admin-list-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      // Add a non-admin user
      await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, 'subjects?role=admin', access_token);
      const body = await resp.json() as any;
      expect(body.subjects.every((s: any) => s.isAdmin)).toBe(true);
    });

    it('rejects non-admin', async () => {
      const inst = 'admin-list-3';
      const stub = env.NEBULA_AUTH.getByName(inst);
      await fullLogin(stub, inst, 'admin@example.com');

      // Login a non-admin user
      const magicLink = await requestMagicLink(stub, inst, 'user@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);
      const { access_token: userToken } = await refreshAndParse(stub, inst, refreshToken);

      const resp = await adminRequest(stub, inst, 'subjects', userToken);
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Get Subject
  // ============================================

  describe('GET /subject/:sub', () => {
    it('returns subject details', async () => {
      const inst = 'admin-get-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token, parsed } = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, `subject/${parsed.sub}`, access_token);
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.email).toBe('admin@example.com');
      expect(body.subject.isAdmin).toBe(true);
    });

    it('returns 404 for missing subject', async () => {
      const inst = 'admin-get-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, 'subject/nonexistent-uuid', access_token);
      expect(resp.status).toBe(404);
    });
  });

  // ============================================
  // Patch Subject
  // ============================================

  describe('PATCH /subject/:sub', () => {
    it('promotes user to admin', async () => {
      const inst = 'admin-patch-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      // Add second user
      const userLogin = await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.isAdmin).toBe(true);
      expect(body.subject.adminApproved).toBe(true);
    });

    it('demotes admin to regular user', async () => {
      const inst = 'admin-patch-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      // Add and promote a user
      const userLogin = await fullLogin(stub, inst, 'user@example.com');
      await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });

      // Demote
      const resp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { isAdmin: false },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.isAdmin).toBe(false);
    });

    it('revokes approval and tokens', async () => {
      const inst = 'admin-patch-3';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      // Add user, approve, then revoke approval
      const userLogin = await fullLogin(stub, inst, 'user@example.com');

      // Approve first
      await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { adminApproved: true },
      });

      // Revoke approval
      const resp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { adminApproved: false },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.adminApproved).toBe(false);
    });

    it('rejects self-modification', async () => {
      const inst = 'admin-patch-4';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token, parsed } = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, `subject/${parsed.sub}`, access_token, {
        method: 'PATCH',
        body: { isAdmin: false },
      });
      expect(resp.status).toBe(403);
    });

    it('rejects bootstrap admin modification', async () => {
      const inst = 'nebula-platform';
      const stub = env.NEBULA_AUTH.getByName(inst);

      // Bootstrap admin login
      const bootstrapLogin = await fullLogin(stub, inst, 'bootstrap-admin@example.com');

      // Add a second admin
      const admin2 = await fullLogin(stub, inst, 'admin2@example.com');
      await adminRequest(stub, inst, `subject/${admin2.parsed.sub}`, bootstrapLogin.access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });

      // Get a fresh token for admin2
      const ml2 = await requestMagicLink(stub, inst, 'admin2@example.com');
      const { refreshToken: rt2 } = await clickMagicLink(stub, ml2);
      const { access_token: token2 } = await refreshAndParse(stub, inst, rt2);

      // Admin2 cannot modify bootstrap admin
      const resp = await adminRequest(stub, inst, `subject/${bootstrapLogin.parsed.sub}`, token2, {
        method: 'PATCH',
        body: { isAdmin: false },
      });
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('forbidden');
    });
  });

  // ============================================
  // Delete Subject
  // ============================================

  describe('DELETE /subject/:sub', () => {
    it('deletes a subject', async () => {
      const inst = 'admin-del-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      const userLogin = await fullLogin(stub, inst, 'user@example.com');

      const resp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token, {
        method: 'DELETE',
      });
      expect(resp.status).toBe(204);

      // Verify deleted
      const getResp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token);
      expect(getResp.status).toBe(404);
    });

    it('rejects self-deletion', async () => {
      const inst = 'admin-del-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token, parsed } = await fullLogin(stub, inst, 'admin@example.com');

      const resp = await adminRequest(stub, inst, `subject/${parsed.sub}`, access_token, {
        method: 'DELETE',
      });
      expect(resp.status).toBe(403);
    });

    it('rejects bootstrap admin deletion', async () => {
      const inst = 'nebula-platform';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const bootstrapLogin = await fullLogin(stub, inst, 'bootstrap-admin@example.com');

      // Add a second admin
      const admin2 = await fullLogin(stub, inst, 'admin2@example.com');
      await adminRequest(stub, inst, `subject/${admin2.parsed.sub}`, bootstrapLogin.access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });

      const ml2 = await requestMagicLink(stub, inst, 'admin2@example.com');
      const { refreshToken: rt2 } = await clickMagicLink(stub, ml2);
      const { access_token: token2 } = await refreshAndParse(stub, inst, rt2);

      const resp = await adminRequest(stub, inst, `subject/${bootstrapLogin.parsed.sub}`, token2, {
        method: 'DELETE',
      });
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Approve Subject
  // ============================================

  describe('GET /approve/:sub', () => {
    it('approves a pending subject via one-click link', async () => {
      const inst = 'admin-approve-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const { access_token } = await fullLogin(stub, inst, 'admin@example.com');

      // Create a non-approved user via magic link
      const userLogin = await fullLogin(stub, inst, 'user@example.com');

      // Approve via cookie-authenticated GET (admin's refresh token)
      const adminMl = await requestMagicLink(stub, inst, 'admin@example.com');
      const { refreshToken: adminRt } = await clickMagicLink(stub, adminMl);

      const resp = await stub.fetch(new Request(url(inst, `approve/${userLogin.parsed.sub}`), {
        headers: { Cookie: `refresh-token=${adminRt}` },
        redirect: 'manual',
      }));
      expect(resp.status).toBe(302);

      // Verify approved
      const getResp = await adminRequest(stub, inst, `subject/${userLogin.parsed.sub}`, access_token);
      const body = await getResp.json() as any;
      expect(body.subject.adminApproved).toBe(true);
    });
  });
});
