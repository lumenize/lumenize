/**
 * Bootstrap-ARRAY (`*` super-admin) — the comma-separated `NEBULA_AUTH_BOOTSTRAP_EMAIL` list
 * (tasks/claude-live-verification.md Phase 3a).
 *
 * Targets ONLY what the array widening adds — a SECOND listed email (beyond index 0) is promoted
 * and modify-protected, and a mixed-case/leading-space entry matches ONLY because the getter
 * normalizes PER ELEMENT. The single-email path + the `access.admin` ENFORCEMENT bypass are covered
 * elsewhere (nebula-auth.test.ts § Bootstrap Admin; dag-tree.test.ts scope-admin bypass with its own
 * mutation-check), so they aren't re-tested here.
 *
 * vitest.config sets `NEBULA_AUTH_BOOTSTRAP_EMAIL='bootstrap-admin@example.com, Second-Bootstrap@Example.com'`.
 * The second entry's leading space + capitals mean a raw `String.prototype.includes` on the joined
 * value (the footgun the getter forbids) — OR a scalar index-0 getter — reds every test below.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { fullLogin, adminRequest } from './test-helpers';

/** The second listed entry as a user types it at login (lowercase). The config entry is the
 *  mixed-case `Second-Bootstrap@Example.com`; the getter must normalize it to match this. */
const SECOND_BOOTSTRAP = 'second-bootstrap@example.com';

describe('Bootstrap-array (* super-admin) — second listed email', () => {
  it('promotes the SECOND listed email to a * platform admin at nebula-platform, via array membership (not founder)', async () => {
    const stub = env.NEBULA_AUTH.getByName('nebula-platform');
    // Found nebula-platform with a DIFFERENT (non-listed) email FIRST, so SECOND_BOOTSTRAP is NOT the
    // founder — its promotion can then come ONLY from `#bootstrapEmails.includes(...)`. Without the
    // founder-first step this would pass vacuously (first-user-is-founder promotes regardless).
    await fullLogin(stub, 'nebula-platform', 'platform-founder@example.com');
    const { parsed } = await fullLogin(stub, 'nebula-platform', SECOND_BOOTSTRAP);
    // Reds if the getter honors only index 0 (scalar) OR does a raw String.includes on the joined
    // value ('…, Second-Bootstrap@Example.com' does NOT contain 'second-bootstrap@example.com').
    expect(parsed.access.authScopePattern).toBe('*'); // platform wildcard
    expect(parsed.access.admin).toBe(true);
    expect(parsed.adminApproved).toBe(true);
  });

  it('promotes the second listed email at a non-platform instance that ALREADY has a founder (subjectCount>0)', async () => {
    const inst = 'bootstrap-array-nonplatform';
    const stub = env.NEBULA_AUTH.getByName(inst);
    const founder = await fullLogin(stub, inst, 'founder@example.com');
    expect(founder.parsed.access.admin).toBe(true); // via the founder clause (first user)
    // subjectCount is now > 0, so the founder clause no longer fires — promotion here is array-only.
    const { parsed } = await fullLogin(stub, inst, SECOND_BOOTSTRAP);
    expect(parsed.access.admin).toBe(true); // reds if the getter is scalar/index-0 (not in list → not promoted)
  });

  it('does NOT promote a non-listed non-founder at subjectCount>0 (control)', async () => {
    const inst = 'bootstrap-array-control';
    const stub = env.NEBULA_AUTH.getByName(inst);
    await fullLogin(stub, inst, 'founder@example.com'); // founder
    const { parsed } = await fullLogin(stub, inst, 'random@example.com'); // not listed, not founder
    expect(parsed.access.admin).toBeUndefined();
    expect(parsed.adminApproved).toBe(false);
  });

  // Modify-protection is guarded independently at PATCH (`#handleUpdateSubject`) and DELETE
  // (`#handleDeleteSubject`), each via its own `#bootstrapEmails.includes(...)`. A scalar getter
  // leaves the second listed email UNprotected (not in `[first]`) → the op would succeed → reds.
  it.each([
    { verb: 'PATCH', method: 'PATCH', body: { isAdmin: false } as Record<string, unknown> | undefined },
    { verb: 'DELETE', method: 'DELETE', body: undefined },
  ])('$verb on the second listed bootstrap admin is refused (403 Cannot modify bootstrap admin)', async ({ method, body }) => {
    const inst = `bootstrap-array-protect-${method.toLowerCase()}`;
    const stub = env.NEBULA_AUTH.getByName(inst);
    const admin = await fullLogin(stub, inst, 'founder@example.com'); // an admin who can drive the admin API
    const target = await fullLogin(stub, inst, SECOND_BOOTSTRAP); // promoted via the array
    expect(target.parsed.access.admin).toBe(true);

    const resp = await adminRequest(stub, inst, `subject/${target.parsed.sub}`, admin.access_token,
      body !== undefined ? { method, body } : { method });
    expect(resp.status).toBe(403);
  });
});
