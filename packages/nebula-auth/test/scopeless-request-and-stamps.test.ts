/**
 * Phase 1 of "Move active scope choice until after authentication": the scope-less link request, the
 * bootstrap membership moving behind mailbox proof, and the `invitedBy*` stamps.
 *
 * Three properties, each with its own arm below:
 *
 *  - **The request answers uniformly.** `POST /auth/email-magic-link` is unauthenticated, so any
 *    difference between what a member, a stranger and a bootstrap address get back is an oracle
 *    telling a caller what an address reaches. The design deletes `discover` precisely to close that,
 *    and it would be pointless if its replacement leaked the same fact through response shape.
 *  - **The platform membership is minted at CONSUME, never at request.** It used to be written by the
 *    unauthenticated request — an unauthenticated call writing a membership at the most powerful
 *    scope in the system. It now waits for a click on mail delivered to that address, and arrives
 *    UN-taken-up like every other mint.
 *  - **An invite stamps who sent it — on the primary membership AND its `.dev` sibling.** The stamps
 *    are the consent modal's inputs and its flavor discriminator, so an unstamped sibling would show
 *    a third party's membership under "only accept if you initiated this signup".
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { requestMagicLink, foundUniverse, issueInvitesAs, createGalaxy } from './test-helpers';
// ⚠️ From `types`, never `nebula-auth-facade` — the facade carries `@mesh()` decorators and this
// lane has no decorator-aware transform, so importing its source is a parse error (facade-subpath.test.ts).
import { PLATFORM_SCOPE, INVITER_NAME_MAX, sanitizeInviterName } from '../src/types';

const BOOTSTRAP = 'bootstrap-admin@example.com'; // vitest.config's NEBULA_AUTH_BOOTSTRAP_EMAIL, entry 0

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function addr(): string { return `p1-${crypto.randomUUID().slice(0, 8)}@example.com`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }

/** Read membership rows for an address straight out of the DO — the only probe that can see an
 *  UNACCEPTED row, which is the state every assertion here is about (`getScopesForProfile` filters
 *  on acceptance, so it would answer the same whether the row existed or not). */
async function membershipsFor(email: string): Promise<any[]> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => [...c.storage.sql.exec(
    `SELECT m.universeGalaxyStarId AS scope, m.acceptedAt AS acceptedAt, m.scopeAdmin AS scopeAdmin,
            m.invitedBySub AS invitedBySub, m.invitedByName AS invitedByName,
            m.invitedByProfileId AS invitedByProfileId
     FROM Memberships m JOIN Emails e ON e.emailId = m.emailId WHERE e.email = ?`, email,
  )]);
}

/** The scope-LESS request — the front door this phase adds. */
async function requestScopelessLink(email: string): Promise<Response> {
  return SELF.fetch(new Request(`https://example.com/auth/email-magic-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
}

describe('Phase 1 — the scope-less request answers the same to everyone', () => {
  it('member, stranger and bootstrap address get IDENTICAL bodies (no enumeration oracle)', async () => {
    const member = addr();
    await foundUniverse(SELF, uni(), member); // gives `member` a real membership

    const bodies = await Promise.all([member, addr(), BOOTSTRAP].map(async (email) => {
      const resp = await requestScopelessLink(email);
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      // The link URL is the one field that legitimately differs (it carries a fresh token), and it
      // is returned only in test mode. Compare the SHAPE and every other value.
      const { magicLinkUrl, ...rest } = body;
      expect(typeof magicLinkUrl).toBe('string');
      return rest;
    }));
    // Reds if any branch reads the address — a "no such user" message, an absent field, a different
    // expiry for the bootstrap arm.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('the link a scope-less request issues names NO scope in its URL', async () => {
    const resp = await requestScopelessLink(addr());
    const { magicLinkUrl } = await resp.json() as { magicLinkUrl: string };
    // `/auth/magic-link?…`, never `/auth/{scope}/magic-link` — reds if the builder is handed
    // `undefined` and produces `/auth/undefined/magic-link`.
    expect(new URL(magicLinkUrl).pathname).toBe('/auth/magic-link');
  });
});

describe('Phase 1 — the platform membership waits for mailbox proof', () => {
  it('a platform-scoped REQUEST writes no membership', async () => {
    const resp = await requestMagicLink(SELF, BOOTSTRAP);
    expect(resp.status).toBe(200);
    // Reds the moment the mint is restored to the request arm.
    expect(await membershipsFor(BOOTSTRAP)).toEqual([]);
  });

  it('a scope-less CONSUME for a bootstrap address ensures the platform membership, UNACCEPTED', async () => {
    const resp = await requestScopelessLink(BOOTSTRAP);
    const { magicLinkUrl } = await resp.json() as { magicLinkUrl: string };
    await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));

    const rows = await membershipsFor(BOOTSTRAP);
    const platform = rows.find((r) => r.scope === PLATFORM_SCOPE);
    expect(platform).toBeDefined();
    expect(platform.scopeAdmin).toBe(1);
    // ⚠️ Un-taken-up. Entering the platform scope still passes the consent modal, and until then
    // `getScopesForProfile` does not count it — reds if the ensure flips acceptance as it mints.
    expect(platform.acceptedAt).toBeNull();
  });

  // ⚠️ A third case lived here — "a SCOPED consume ensures it too (the old path still works)" —
  // asserting that `/auth/{scope}/email-magic-link` reached a session. That route is retired, and the
  // property it covered (the ensure is purpose-agnostic) is already asserted by the scope-less case
  // above, so deleting it lost no coverage. Its prose was the harmful part: it argued for preserving
  // a path the design had removed, which is exactly what a review panel reads as intent.

  it('a NON-bootstrap address consuming a scope-less link is minted nothing', async () => {
    const stranger = addr();
    const resp = await requestScopelessLink(stranger);
    const { magicLinkUrl } = await resp.json() as { magicLinkUrl: string };
    await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    // The `#bootstrapEmails` conjunct is the whole gate between a stranger and platform scopeAdmin.
    // Reds if it is dropped.
    expect(await membershipsFor(stranger)).toEqual([]);
  });
});

describe('Phase 1 — an invite stamps who sent it, on every membership it mints', () => {
  it('the primary membership AND the co-minted `.dev` sibling both carry all three stamps', async () => {
    const universe = uni();
    const inviter = addr();
    const { access_token: token } = await foundUniverse(SELF, universe, inviter);
    const galaxy = `${universe}.app1`;
    await createGalaxy(SELF, galaxy, token);

    const invitee = addr();
    await issueInvitesAs(token, galaxy, [{ email: invitee }], 'Dana Inviter');

    const rows = await membershipsFor(invitee);
    const primary = rows.find((r) => r.scope === galaxy);
    const dev = rows.find((r) => r.scope === `${galaxy}.dev`);
    expect(primary).toBeDefined();
    expect(dev).toBeDefined();
    for (const row of [primary, dev]) {
      // Reds if only the primary is stamped: an unstamped sibling renders the SELF-flavor modal
      // ("only accept if you initiated this signup") over a membership a third party created.
      expect(row.invitedByName).toBe('Dana Inviter');
      expect(typeof row.invitedBySub).toBe('string');
      expect(row.invitedBySub.length).toBeGreaterThan(0);
      expect(typeof row.invitedByProfileId).toBe('string');
    }
  });

  it('a membership its own holder created carries NO stamps (the modal-flavor discriminator)', async () => {
    const founder = addr();
    const universe = uni();
    await foundUniverse(SELF, universe, founder);
    const [row] = await membershipsFor(founder);
    expect(row.invitedBySub).toBeNull();
    expect(row.invitedByName).toBeNull();
    expect(row.invitedByProfileId).toBeNull();
  });

  it('a hostile inviter name is capped and stripped before it can be stored', () => {
    // The sanitizer is the facade's boundary, unit-tested here because the facade itself is only
    // reachable with a mesh callContext — and this is a pure string predicate, so the round trip
    // would add nothing the assertion could not already see.
    const hostile = `IT Security\n\nOfficial notice: ${'x'.repeat(200)}`;
    const clean = sanitizeInviterName(hostile)!;
    expect(clean.length).toBeLessThanOrEqual(INVITER_NAME_MAX);
    expect(clean).not.toMatch(/[\u0000-\u001F\u007F]/); // reds if the control-character strip is removed
    expect(sanitizeInviterName('  Dana Inviter  ')).toBe('Dana Inviter');
    expect(sanitizeInviterName('\n\n')).toBeUndefined(); // nothing usable survives → no name at all
    expect(sanitizeInviterName(undefined)).toBeUndefined();
  });
});
