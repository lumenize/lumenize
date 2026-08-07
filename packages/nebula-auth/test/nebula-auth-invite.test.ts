/**
 * Invite flow — through the Worker over the registry (the dissolved-DO model,
 * tasks/nebula-auth-surrogate-sub.md). Issuance MINTS the invitee identity (an authority point,
 * `scopeAdmin=0`); accept find-and-flips it; the invite token is single-use.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { foundUniverse, adminRequest, url } from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }

describe('Invite Flow', () => {
  describe('POST /invite', () => {
    it('invites a new user; they accept + log in as a non-admin member; discover records them', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const scope = `${u}.app.tenant`;

      const resp = await adminRequest(SELF, scope, 'invite', admin.access_token, {
        method: 'POST', body: { emails: ['newuser@example.com'] },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.invited).toContain('newuser@example.com');
      const link = body.links['newuser@example.com'];
      expect(link).toContain('accept-invite');

      const accept = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(accept.status).toBe(302);
      expect(accept.headers.get('Set-Cookie')).toContain('refresh-token=');

      const disc = await getRegistry().discover('newuser@example.com');
      expect(disc).toEqual([{ universeGalaxyStarId: scope, scopeAdmin: false }]);
    });

    it('re-inviting the same email is idempotent — ONE identity, not a duplicate', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const scope = `${u}.app.tenant`;
      for (let i = 0; i < 2; i++) {
        const r = await adminRequest(SELF, scope, 'invite', admin.access_token, {
          method: 'POST', body: { emails: ['dup@example.com'] },
        });
        expect(r.status).toBe(200);
      }
      expect(await getRegistry().discover('dup@example.com')).toHaveLength(1);
    });

    it('batch invites multiple emails; reports invalid ones in errors', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const resp = await adminRequest(SELF, `${u}.app.tenant`, 'invite', admin.access_token, {
        method: 'POST', body: { emails: ['a@example.com', 'b@example.com', 'not-an-email'] },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.invited.sort()).toEqual(['a@example.com', 'b@example.com']);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].email).toBe('not-an-email');
    });

    it('rejects a non-admin caller (403) — issuance is admin-gated at the registry', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const scope = `${u}.app.tenant`;
      // Invite a plain member, log them in, and have them try to invite → 403 (not admin).
      const inviteResp = await adminRequest(SELF, scope, 'invite', admin.access_token, {
        method: 'POST', body: { emails: ['member@example.com'] },
      });
      const link = (await inviteResp.json() as any).links['member@example.com'];
      const accept = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      const refreshToken = accept.headers.get('Set-Cookie')!.split(';')[0].split('=')[1];
      const refreshResp = await SELF.fetch(new Request(url(scope, 'refresh-token'), {
        method: 'POST',
        headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: scope }),
      }));
      const memberToken = (await refreshResp.json() as any).access_token;

      const denied = await adminRequest(SELF, scope, 'invite', memberToken, {
        method: 'POST', body: { emails: ['victim@example.com'] },
      });
      expect(denied.status).toBe(403);
    });
  });

  describe('GET /accept-invite', () => {
    it('rejects a missing invite_token (400)', async () => {
      const resp = await SELF.fetch(new Request(url('someu', 'accept-invite'), { redirect: 'manual' }));
      expect(resp.status).toBe(400);
      expect((await resp.json() as any).error).toBe('invalid_request');
    });

    it('rejects an invalid invite token (302 error redirect)', async () => {
      const resp = await SELF.fetch(new Request(url('someu', 'accept-invite?invite_token=bogus'), { redirect: 'manual' }));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });
  });

  describe('single-use (replay prevention)', () => {
    it('an accepted invite token cannot be reused', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'admin@example.com');
      const scope = `${u}.app.tenant`;
      const inviteResp = await adminRequest(SELF, scope, 'invite', admin.access_token, {
        method: 'POST', body: { emails: ['replay@example.com'] },
      });
      const link = (await inviteResp.json() as any).links['replay@example.com'];

      const first = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(first.status).toBe(302);
      expect(first.headers.get('Set-Cookie')).toContain('refresh-token=');

      const replay = await SELF.fetch(new Request(link, { redirect: 'manual' }));
      expect(replay.status).toBe(302);
      expect(replay.headers.get('Location')).toContain('error=invalid_token'); // token was deleted
    });
  });
});
