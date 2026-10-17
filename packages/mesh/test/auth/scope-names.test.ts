/**
 * Every scope name is a legal host label, and the root cannot be one (ADR-021).
 *
 * In-lane rather than `/live`: each limb is the slug grammar or a reserved-name set, answered by
 * the Registry before it writes anything, so a running system shows nothing these cannot. The one
 * property that needs the running system, the root still flowing through a real superuser login,
 * is `harness/scenarios/superuser-front-door.ts`'s.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { PLATFORM_SCOPE } from '../../src/auth/types';
import {
  authUrl, claimStar, createGalaxy, foundUniverse, proveNewAddress, signupClaim,
} from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `names-${crypto.randomUUID().slice(0, 8)}@example.com`;

function claimUniverse(slug: string, email = addr(), appSlug = 'first'): Promise<Response> {
  return SELF.fetch(new Request(authUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, appSlug, email }),
  }));
}

async function refusal(resp: Response): Promise<{ status: number; error: string; message: string }> {
  const body = await resp.json() as { error: string; error_description: string };
  return { status: resp.status, error: body.error, message: body.error_description };
}

describe('the root cannot be claimed, and no guard names it', () => {
  it('both claim paths refuse the root by the slug grammar alone', async () => {
    // The constant, not a literal: set it to a name the grammar accepts and the reserved set does
    // not catch, and the claim goes through, because no check names the root.
    expect(await refusal(await claimUniverse(PLATFORM_SCOPE))).toEqual({
      status: 400, error: 'invalid_slug', message: 'Invalid universe slug format',
    });
    const { ticket } = await proveNewAddress(SELF, addr());
    expect(await refusal(await signupClaim(SELF, { slug: PLATFORM_SCOPE }, ticket))).toEqual({
      status: 400, error: 'invalid_slug', message: 'Invalid universe slug format',
    });

    // Positive control: an ordinary slug claims on both paths, the ticket path with the same ticket,
    // since a refused claim does not spend it.
    expect((await claimUniverse(uni())).status).toBe(200);
    expect((await signupClaim(SELF, { slug: uni() }, ticket)).status).toBe(200);
  });
});

describe('both claim paths refuse a platform host label', () => {
  it('`www` is refused as a universe slug, directly and with a signup ticket', async () => {
    expect(await refusal(await claimUniverse('www'))).toEqual({
      status: 400, error: 'reserved_slug', message: '"www" is reserved',
    });
    const { ticket } = await proveNewAddress(SELF, addr());
    expect(await refusal(await signupClaim(SELF, { slug: 'www' }, ticket))).toEqual({
      status: 400, error: 'reserved_slug', message: 'That name is reserved',
    });
    for (const slug of ['platform', 'email']) {
      expect((await refusal(await signupClaim(SELF, { slug }, ticket))).error, slug).toBe('reserved_slug');
    }
  });
});

describe('a slug caps at 30 characters', () => {
  const TOO_LONG = 'northwind-traders-international'; // 31
  const LONGEST_KIND = 'warehouse-management-system';     // 27

  it('refuses 31 characters at both claim paths, and passes 27', async () => {
    expect(TOO_LONG).toHaveLength(31);
    expect(await refusal(await claimUniverse(TOO_LONG))).toEqual({
      status: 400, error: 'invalid_slug', message: 'Invalid universe slug format',
    });
    const { ticket } = await proveNewAddress(SELF, addr());
    expect((await refusal(await signupClaim(SELF, { slug: TOO_LONG }, ticket))).error).toBe('invalid_slug');

    // Positive control. One run claims this name for good, so it is suffixed to stay unique
    // while keeping the 27 characters the limb is about.
    const passes = `${LONGEST_KIND.slice(0, 20)}-${crypto.randomUUID().slice(0, 6)}`;
    expect(passes).toHaveLength(27);
    expect((await claimUniverse(passes)).status).toBe(200);
  });
});

describe('an environment name is not a Star slug', () => {
  it('claim-star refuses `staging` under a real galaxy, by message', async () => {
    const u = uni();
    const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
    const galaxy = `${u}.app`;
    await createGalaxy(galaxy, access_token);

    expect(await refusal(await claimStar(SELF, `${galaxy}.staging`, addr()))).toEqual({
      status: 400, error: 'reserved_slug', message: '"staging" is a reserved environment name',
    });
    // Positive control: a tenant slug under the same galaxy claims.
    expect((await claimStar(SELF, `${galaxy}.tenant1`, addr())).status).toBe(200);
  });
});
