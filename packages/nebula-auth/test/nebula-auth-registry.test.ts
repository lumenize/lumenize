/**
 * Registry tests — NebulaAuthRegistry DO, NA→R wiring, discovery,
 * self-signup, galaxy creation.
 *
 * Uses Workers RPC to call registry methods directly.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { fullLogin, requestMagicLink, clickMagicLink, refreshAndParse, adminRequest, url } from './test-helpers';

/** Get the singleton registry stub (cast to any for RPC method access) */
function getRegistry(): any {
  return env.NEBULA_AUTH_REGISTRY.getByName('registry');
}

describe('NebulaAuthRegistry', () => {

  // ============================================
  // Direct RPC: registerEmail / removeEmail / updateEmailRole
  // ============================================

  describe('registerEmail / removeEmail / updateEmailRole', () => {
    it('registers an email→scope mapping', async () => {
      const registry = getRegistry();
      await registry.registerEmail('alice@example.com', 'acme.crm.tenant-a', false);

      const entries = await registry.discover('alice@example.com');
      expect(entries).toHaveLength(1);
      expect(entries[0].instanceName).toBe('acme.crm.tenant-a');
      expect(entries[0].isAdmin).toBe(false);
    });

    it('upserts on duplicate (email, instanceName)', async () => {
      const registry = getRegistry();
      await registry.registerEmail('bob@example.com', 'acme.crm.tenant-b', false);
      await registry.registerEmail('bob@example.com', 'acme.crm.tenant-b', true);

      const entries = await registry.discover('bob@example.com');
      expect(entries).toHaveLength(1);
      expect(entries[0].isAdmin).toBe(true);
    });

    it('registers same email in multiple instances', async () => {
      const registry = getRegistry();
      await registry.registerEmail('carol@example.com', 'acme.crm.star-a', false);
      await registry.registerEmail('carol@example.com', 'acme.crm.star-b', true);

      const entries = await registry.discover('carol@example.com');
      expect(entries).toHaveLength(2);
      const names = entries.map((e: any) => e.instanceName).sort();
      expect(names).toEqual(['acme.crm.star-a', 'acme.crm.star-b']);
    });

    it('removes an email→scope mapping', async () => {
      const registry = getRegistry();
      await registry.registerEmail('dave@example.com', 'acme.crm.tenant-d', false);
      await registry.removeEmail('dave@example.com', 'acme.crm.tenant-d');

      const entries = await registry.discover('dave@example.com');
      expect(entries).toHaveLength(0);
    });

    it('updates email role', async () => {
      const registry = getRegistry();
      await registry.registerEmail('eve@example.com', 'acme.crm.tenant-e', false);
      await registry.updateEmailRole('eve@example.com', 'acme.crm.tenant-e', true);

      const entries = await registry.discover('eve@example.com');
      expect(entries).toHaveLength(1);
      expect(entries[0].isAdmin).toBe(true);
    });
  });

  // ============================================
  // Discovery
  // ============================================

  describe('discover', () => {
    it('returns empty array for unknown email', async () => {
      const registry = getRegistry();
      const entries = await registry.discover('nobody@example.com');
      expect(entries).toEqual([]);
    });

    it('case-insensitive email lookup', async () => {
      const registry = getRegistry();
      await registry.registerEmail('FRANK@Example.COM', 'acme.crm.tenant-f', false);

      const entries = await registry.discover('frank@example.com');
      expect(entries).toHaveLength(1);
    });
  });

  // ============================================
  // Slug Availability
  // ============================================

  describe('checkSlugAvailable', () => {
    it('returns true for unused slug', async () => {
      const registry = getRegistry();
      const available = await registry.checkSlugAvailable('brand-new-slug');
      expect(available).toBe(true);
    });

    it('returns false for taken slug', async () => {
      const registry = getRegistry();
      // Register an email which auto-creates the instance
      await registry.registerEmail('x@example.com', 'taken-slug', false);
      const available = await registry.checkSlugAvailable('taken-slug');
      expect(available).toBe(false);
    });
  });

  // ============================================
  // Self-Signup: claimUniverse
  // ============================================

  describe('claimUniverse', () => {
    it('claims a universe and sends magic link', async () => {
      const registry = getRegistry();
      const result = await registry.claimUniverse(
        'my-universe', 'founder@example.com', 'http://localhost',
      );

      expect(result.message).toContain('Check your email');
      expect(result.magicLinkUrl).toContain('/auth/my-universe/magic-link');

      // Instance should be recorded
      const available = await registry.checkSlugAvailable('my-universe');
      expect(available).toBe(false);
    });

    it('completes magic link login → founding admin', async () => {
      const registry = getRegistry();
      const result = await registry.claimUniverse(
        'founder-univ', 'founder@example.com', 'http://localhost',
      );

      // Click the magic link on the NA instance
      const naStub = env.NEBULA_AUTH.getByName('founder-univ');
      const { refreshToken } = await clickMagicLink(naStub, result.magicLinkUrl!);
      const { parsed } = await refreshAndParse(naStub, 'founder-univ', refreshToken);

      expect(parsed.access.admin).toBe(true);
      expect(parsed.adminApproved).toBe(true);

      // Registry should have the email→scope mapping (set during magic link completion)
      const entries = await registry.discover('founder@example.com');
      expect(entries.some((e: any) => e.instanceName === 'founder-univ')).toBe(true);
    });

    it('rejects duplicate universe slug', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('taken-univ', 'first@example.com', 'http://localhost');

      await expect(
        registry.claimUniverse('taken-univ', 'second@example.com', 'http://localhost'),
      ).rejects.toThrow(/already claimed/);
    });

    it('rejects reserved nebula-platform slug', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimUniverse('nebula-platform', 'hacker@example.com', 'http://localhost'),
      ).rejects.toThrow(/reserved/);
    });

    it('rejects invalid slug format', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimUniverse('INVALID SLUG!', 'x@example.com', 'http://localhost'),
      ).rejects.toThrow(/Invalid/);
    });
  });

  // ============================================
  // Self-Signup: claimStar
  // ============================================

  describe('claimStar', () => {
    it('claims a star under an existing galaxy', async () => {
      const registry = getRegistry();

      // Set up parent universe and galaxy
      await registry.claimUniverse('star-univ', 'admin@example.com', 'http://localhost');
      await registry.createGalaxy('star-univ.my-app', { authScopePattern: 'star-univ.*', admin: true });

      // Claim star
      const result = await registry.claimStar(
        'star-univ.my-app.tenant-1', 'tenant@example.com', 'http://localhost',
      );

      expect(result.message).toContain('Check your email');
      expect(result.magicLinkUrl).toContain('/auth/star-univ.my-app.tenant-1/magic-link');
    });

    it('rejects star under nonexistent galaxy', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimStar('no-univ.no-galaxy.star', 'x@example.com', 'http://localhost'),
      ).rejects.toThrow(/does not exist/);
    });

    it('rejects non-star tier id', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimStar('just-a-universe', 'x@example.com', 'http://localhost'),
      ).rejects.toThrow(/3-segment/);
    });

    it('rejects duplicate star slug', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('dup-star-univ', 'admin@example.com', 'http://localhost');
      await registry.createGalaxy('dup-star-univ.app', { authScopePattern: 'dup-star-univ.*', admin: true });
      await registry.claimStar('dup-star-univ.app.tenant', 'first@example.com', 'http://localhost');

      await expect(
        registry.claimStar('dup-star-univ.app.tenant', 'second@example.com', 'http://localhost'),
      ).rejects.toThrow(/already claimed/);
    });
  });

  // ============================================
  // Galaxy Creation
  // ============================================

  describe('createGalaxy', () => {
    it('creates a galaxy under an existing universe', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('gal-univ', 'admin@example.com', 'http://localhost');

      const result = await registry.createGalaxy(
        'gal-univ.my-galaxy',
        { authScopePattern: 'gal-univ.*', admin: true },
      );
      expect(result.instanceName).toBe('gal-univ.my-galaxy');

      const available = await registry.checkSlugAvailable('gal-univ.my-galaxy');
      expect(available).toBe(false);
    });

    it('platform admin can create galaxy', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('plat-gal-univ', 'x@example.com', 'http://localhost');

      const result = await registry.createGalaxy(
        'plat-gal-univ.galaxy',
        { authScopePattern: '*', admin: true },
      );
      expect(result.instanceName).toBe('plat-gal-univ.galaxy');
    });

    it('rejects non-admin caller', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('nonadmin-gal-univ', 'x@example.com', 'http://localhost');

      await expect(
        registry.createGalaxy(
          'nonadmin-gal-univ.galaxy',
          { authScopePattern: 'nonadmin-gal-univ.*', admin: false },
        ),
      ).rejects.toThrow(/admin access/);
    });

    it('rejects galaxy under nonexistent universe', async () => {
      const registry = getRegistry();
      await expect(
        registry.createGalaxy(
          'nonexistent.galaxy',
          { authScopePattern: 'nonexistent.*', admin: true },
        ),
      ).rejects.toThrow(/does not exist/);
    });

    it('rejects non-galaxy tier id', async () => {
      const registry = getRegistry();
      await expect(
        registry.createGalaxy(
          'just-a-universe',
          { authScopePattern: '*', admin: true },
        ),
      ).rejects.toThrow(/2-segment/);
    });

    it('rejects galaxy admin with wrong scope', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('scope-gal-univ', 'x@example.com', 'http://localhost');

      await expect(
        registry.createGalaxy(
          'scope-gal-univ.galaxy',
          { authScopePattern: 'other-univ.*', admin: true },
        ),
      ).rejects.toThrow(/admin access/);
    });

    it('rejects duplicate galaxy', async () => {
      const registry = getRegistry();
      await registry.claimUniverse('dup-gal-univ', 'x@example.com', 'http://localhost');
      await registry.createGalaxy('dup-gal-univ.galaxy', { authScopePattern: 'dup-gal-univ.*', admin: true });

      await expect(
        registry.createGalaxy(
          'dup-gal-univ.galaxy',
          { authScopePattern: 'dup-gal-univ.*', admin: true },
        ),
      ).rejects.toThrow(/already claimed/);
    });
  });

  // ============================================
  // NA→R Wiring: magic link first-verify registers email
  // ============================================

  describe('NA→R wiring: magic link registers email in registry', () => {
    it('first magic link verification creates email→scope mapping', async () => {
      const inst = 'nar-ml-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const registry = getRegistry();

      // Before login: no mapping
      let entries = await registry.discover('nar-ml-user@example.com');
      expect(entries).toHaveLength(0);

      // Login via magic link
      await fullLogin(stub, inst, 'nar-ml-user@example.com');

      // After login: mapping exists
      entries = await registry.discover('nar-ml-user@example.com');
      expect(entries.some((e: any) => e.instanceName === inst)).toBe(true);
    });

    it('second login does not duplicate registry entry', async () => {
      const inst = 'nar-ml-2';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const registry = getRegistry();

      await fullLogin(stub, inst, 'nar-ml-user2@example.com');
      await fullLogin(stub, inst, 'nar-ml-user2@example.com');

      const entries = await registry.discover('nar-ml-user2@example.com');
      const matching = entries.filter((e: any) => e.instanceName === inst);
      expect(matching).toHaveLength(1);
    });
  });

  // ============================================
  // NA→R Wiring: invite registers email in registry
  // ============================================

  describe('NA→R wiring: invite registers email in registry', () => {
    it('invite pre-registers email→scope mapping', async () => {
      const inst = 'nar-inv-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const registry = getRegistry();

      const admin = await fullLogin(stub, inst, 'admin@example.com');

      // Invite a new user
      await adminRequest(stub, inst, 'invite?_test=true', admin.access_token, {
        method: 'POST',
        body: { emails: ['invitee@example.com'] },
      });

      // Email should be in registry even before invitee accepts
      const entries = await registry.discover('invitee@example.com');
      expect(entries.some((e: any) => e.instanceName === inst)).toBe(true);
    });
  });

  // ============================================
  // NA→R Wiring: delete removes email from registry
  // ============================================

  describe('NA→R wiring: delete removes email from registry', () => {
    it('deleting a subject removes email→scope from registry', async () => {
      const inst = 'nar-del-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const registry = getRegistry();

      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'delete-me@example.com');

      // Confirm registered
      let entries = await registry.discover('delete-me@example.com');
      expect(entries.some((e: any) => e.instanceName === inst)).toBe(true);

      // Delete subject
      await adminRequest(stub, inst, `subject/${user.parsed.sub}`, admin.access_token, {
        method: 'DELETE',
      });

      // Confirm removed from registry
      entries = await registry.discover('delete-me@example.com');
      expect(entries.some((e: any) => e.instanceName === inst)).toBe(false);
    });
  });

  // ============================================
  // NA→R Wiring: role change updates registry
  // ============================================

  describe('NA→R wiring: role change updates registry', () => {
    it('promoting to admin updates registry isAdmin flag', async () => {
      const inst = 'nar-role-1';
      const stub = env.NEBULA_AUTH.getByName(inst);
      const registry = getRegistry();

      const admin = await fullLogin(stub, inst, 'admin@example.com');
      const user = await fullLogin(stub, inst, 'promote-me@example.com');

      // Before promotion: not admin in registry
      let entries = await registry.discover('promote-me@example.com');
      let entry = entries.find((e: any) => e.instanceName === inst);
      expect(entry?.isAdmin).toBe(false);

      // Promote
      await adminRequest(stub, inst, `subject/${user.parsed.sub}`, admin.access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });

      // After promotion: admin in registry
      entries = await registry.discover('promote-me@example.com');
      entry = entries.find((e: any) => e.instanceName === inst);
      expect(entry?.isAdmin).toBe(true);
    });
  });

  // ============================================
  // Discovery integration (from Validation Plan)
  // ============================================

  describe('Discovery integration', () => {
    it('discovery returns all scopes for an email, revocation removes one', async () => {
      const registry = getRegistry();

      // Create two stars with the same email
      const stubA = env.NEBULA_AUTH.getByName('disc.crm.star-a');
      const stubB = env.NEBULA_AUTH.getByName('disc.crm.star-b');
      await fullLogin(stubA, 'disc.crm.star-a', 'carol@example.com');
      await fullLogin(stubB, 'disc.crm.star-b', 'carol@example.com');

      // Both scopes returned
      let entries = await registry.discover('carol@example.com');
      const names = entries.map((e: any) => e.instanceName);
      expect(names).toContain('disc.crm.star-a');
      expect(names).toContain('disc.crm.star-b');

      // Revoke from star-b: need an admin in star-b
      // The first user is founding admin, so carol IS the admin
      const carolB = await fullLogin(stubB, 'disc.crm.star-b', 'carol@example.com');

      // Add a second user then delete carol from star-b
      const user2 = await fullLogin(stubB, 'disc.crm.star-b', 'user2@example.com');

      // Carol can't delete herself, so let's promote user2 and use them to delete carol
      await adminRequest(stubB, 'disc.crm.star-b', `subject/${user2.parsed.sub}`, carolB.access_token, {
        method: 'PATCH',
        body: { isAdmin: true },
      });

      // user2 needs a fresh token (now admin)
      const user2Fresh = await fullLogin(stubB, 'disc.crm.star-b', 'user2@example.com');
      await adminRequest(stubB, 'disc.crm.star-b', `subject/${carolB.parsed.sub}`, user2Fresh.access_token, {
        method: 'DELETE',
      });

      // Discovery now only returns star-a
      entries = await registry.discover('carol@example.com');
      const updatedNames = entries.map((e: any) => e.instanceName);
      expect(updatedNames).toContain('disc.crm.star-a');
      expect(updatedNames).not.toContain('disc.crm.star-b');
    });
  });

  // ============================================
  // Email validation on claim paths
  // ============================================

  describe('email validation', () => {
    it('claimUniverse rejects invalid email format', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimUniverse('email-val-univ', 'not-an-email', 'http://localhost'),
      ).rejects.toThrow(/invalid.*email/i);
    });

    it('claimUniverse rejects email missing local part', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimUniverse('email-val-univ-2', '@domain.com', 'http://localhost'),
      ).rejects.toThrow(/invalid.*email/i);
    });

    it('claimUniverse rejects email missing domain', async () => {
      const registry = getRegistry();
      await expect(
        registry.claimUniverse('email-val-univ-3', 'user@', 'http://localhost'),
      ).rejects.toThrow(/invalid.*email/i);
    });

    it('claimStar rejects invalid email format', async () => {
      const registry = getRegistry();
      // Need a parent galaxy to exist
      await registry.claimUniverse('cs-email-val', 'valid@example.com', 'http://localhost');
      const naStub = (env as any).NEBULA_AUTH.getByName('cs-email-val');
      await fullLogin(naStub, 'cs-email-val', 'valid@example.com');
      await registry.createGalaxy('cs-email-val.app', { authScopePattern: 'cs-email-val.*', admin: true });

      await expect(
        registry.claimStar('cs-email-val.app.tenant', 'bad-email', 'http://localhost'),
      ).rejects.toThrow(/invalid.*email/i);
    });
  });
});
