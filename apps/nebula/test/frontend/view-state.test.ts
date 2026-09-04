/**
 * The pure decisions of the routing module (`apps/nebula-studio-ui/src/view-state.ts`). Pure: which
 * overlays a query names, and whether a remembered return-to is still usable — no running system is
 * involved, so this is the one place `/live` is not the default tier (`live.md`). The live half is
 * `studio-overlays-by-url`.
 */
import { describe, it, expect } from 'vitest';
import { parseOverlay, withOverlay, validReturnTo, RETURN_MAX_AGE_MS } from '../../../nebula-studio-ui/src/view-state';
import { returnTarget, type ScopeSummary } from '../../../nebula-studio-ui/src/auth/home-logic';

describe('parseOverlay / withOverlay', () => {
  it('round-trips every overlay and ignores unknown parameters', () => {
    const q = withOverlay('?utm=1', { profile: true, transcript: 'm1' });
    expect(q).toBe('?utm=1&profile&transcript=m1');
    expect(parseOverlay(q)).toEqual({ profile: true, manage: false, transcript: 'm1', create: false });
    expect(withOverlay(q, { profile: false, transcript: undefined })).toBe('?utm=1');
  });
});

describe('validReturnTo', () => {
  const now = 1_000_000_000;
  it('honours a fresh relative path', () => {
    expect(validReturnTo({ path: '/acme.crm?manage', at: now - 1000 }, now)).toBe('/acme.crm?manage');
  });
  it('rejects an absolute URL and a protocol-relative one — an open redirect', () => {
    expect(validReturnTo({ path: 'https://evil.example/', at: now }, now)).toBeUndefined();
    expect(validReturnTo({ path: '//evil.example/', at: now }, now)).toBeUndefined();
  });
  it('rejects a stale entry, a future-dated one, and garbage', () => {
    expect(validReturnTo({ path: '/acme', at: now - RETURN_MAX_AGE_MS - 1 }, now)).toBeUndefined();
    expect(validReturnTo({ path: '/acme', at: now + 1 }, now)).toBeUndefined();
    expect(validReturnTo(null, now)).toBeUndefined();
    expect(validReturnTo({ path: 42, at: now }, now)).toBeUndefined();
  });
});

describe('returnTarget', () => {
  const summary = (memberships: ScopeSummary['emails'][number]['memberships']): ScopeSummary =>
    ({ emails: [{ email: 'a@lumenize.io', current: true, memberships }] } as unknown as ScopeSummary);
  it('a universe membership covers a workspace beneath it, keyed by the DESTINATION scope', () => {
    const t = returnTarget(summary([{ scope: 'acme', tier: 'universe', accepted: true }]), '/acme.crm?manage');
    expect(t).toEqual({ scope: 'acme.crm', path: '/acme.crm?manage' });
  });
  it('an unaccepted membership, or a scope the person does not hold, is not a destination', () => {
    expect(returnTarget(summary([{ scope: 'acme', tier: 'universe', accepted: false }]), '/acme.crm')).toBeUndefined();
    expect(returnTarget(summary([{ scope: 'acme', tier: 'universe', accepted: true }]), '/acmeco.crm')).toBeUndefined();
    expect(returnTarget(summary([{ scope: 'acme', tier: 'universe', accepted: true }]), '/')).toBeUndefined();
  });
});
