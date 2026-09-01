/**
 * Phase 6: the fallback slug screen's authorization, and the coming-soon demand signal.
 *
 * The signup ticket exists because of an asymmetry in the newbie path. Someone who declares
 * themselves new uses the login form's "Create a new account" affordance and never gets here.
 * Someone who does not — who just types their address in — proves their mailbox and arrives with
 * nothing to enter. Sending a *second* email so they can claim an account is precisely the
 * interaction this design was built to delete, so the click that proved the address issues a ticket
 * instead, and the slug screen spends it.
 *
 * That makes the ticket a credential, and the tests below are mostly about what it must NOT buy:
 *
 *  - **It is spendable only at the claim.** Not at a magic-link request, not at an accept.
 *  - **It carries the address.** A body-supplied one is ignored, because otherwise anyone holding
 *    any ticket could claim an account in someone else's name.
 *  - **It expires.** Minutes, not the magic link's half hour — the screen it authorizes is the very
 *    next navigation.
 *
 * The coming-soon route is here because it is the phase's other unauthenticated addition, and its
 * one real property is that its tag is a closed set rather than free text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { foundUniverse, url, expectNoSession } from './test-helpers';
import { SIGNUP_TICKET_TTL, COMING_SOON_TAGS } from '../src/types';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p6-${crypto.randomUUID().slice(0, 8)}@example.com`;
const getRegistry = (): any => env.NEBULA_AUTH_REGISTRY.getByName('registry');

/** Read one cookie's value out of a response's `Set-Cookie` list. */
function cookieValue(resp: Response, name: string): string | undefined {
  const all = (resp.headers as any).getSetCookie?.() as string[] | undefined
    ?? [resp.headers.get('Set-Cookie') ?? ''];
  for (const c of all) {
    const [pair] = c.split(';');
    const [k, ...rest] = pair.split('=');
    if (k.trim() === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Drive the real front door for a BRAND-NEW address: request a scope-less link, click it, and hand
 * back the ticket that click issued. Rung 2 (test-mode issuance) — the point here is the ticket the
 * server minted, not the mail transport.
 */
async function proveNewAddress(email: string): Promise<{ ticket: string; location: string }> {
  const req = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }));
  const { magicLinkUrl } = await req.json() as { magicLinkUrl: string };
  const resp = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
  expect(resp.status).toBe(302);
  const ticket = cookieValue(resp, 'signup-ticket');
  expect(ticket, 'the zero-membership consume must issue a signup ticket').toBeDefined();
  return { ticket: ticket!, location: resp.headers.get('Location')! };
}

/** POST the slug screen's claim with an explicit cookie header. */
function claim(body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(new Request('https://example.com/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  }));
}

/** Which address, if any, holds a membership at this scope. */
async function claimerOf(scope: string): Promise<string | null> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
    const rows = [...c.storage.sql.exec(
      `SELECT e.email AS email FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE m.universeGalaxyStarId = ?`, scope)];
    return rows.length ? rows[0].email : null;
  });
}

describe('Phase 6 — the signup ticket authorizes the slug screen, and nothing else', () => {
  it('a new address lands on signup with a ticket, and spends it to claim in ONE step', async () => {
    const person = addr();
    const { ticket, location } = await proveNewAddress(person);
    expect(location).toBe('/auth/signup'); // nothing to enter, so not a Home screen

    const slug = uni();
    const resp = await claim({ slug }, `signup-ticket=${ticket}`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ scope: slug, home: `/auth/${slug}/home` });

    // The claim logged them in directly — the whole point of the ticket is that no SECOND email is
    // sent, so a refresh cookie must come back from this very response.
    expect(cookieValue(resp, 'refresh-token')).toBeDefined();
    expect(await claimerOf(slug)).toBe(person);
  });

  it('the ticket is SINGLE-USE — replaying it claims nothing', async () => {
    const { ticket } = await proveNewAddress(addr());
    expect((await claim({ slug: uni() }, `signup-ticket=${ticket}`)).status).toBe(200);

    const second = uni();
    const replay = await claim({ slug: second }, `signup-ticket=${ticket}`);
    expect(replay.status).toBe(403);
    // The refusal is the assertion only if nothing was written — a 403 with a claimed scope behind
    // it would be worse than no check at all.
    expect(await claimerOf(second)).toBeNull();
  });

  it('an UNRECOGNISED ticket is refused', async () => {
    const slug = uni();
    const resp = await claim({ slug }, 'signup-ticket=not-a-real-ticket-value-at-all');
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain('invalid_ticket');
    expect(await claimerOf(slug)).toBeNull();
  });

  it('NO ticket at all is refused — the cookie is the whole authorization', async () => {
    const slug = uni();
    const resp = await claim({ slug });
    expect(resp.status).toBe(401);
    expect(await claimerOf(slug)).toBeNull();
  });

  it('an EXPIRED ticket is refused, and a fresh one at the same instant works', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { ticket } = await proveNewAddress(addr());
      // Past the ticket's life but well inside a magic link's — so this reds against a ticket that
      // silently inherited MAGIC_LINK_TTL, not merely against one that never expires.
      vi.setSystemTime(new Date(Date.now() + (SIGNUP_TICKET_TTL + 60) * 1000));

      const stale = uni();
      const expired = await claim({ slug: stale }, `signup-ticket=${ticket}`);
      expect(expired.status).toBe(403);
      expect(await claimerOf(stale)).toBeNull();

      // Positive control at the SAME clock reading: without it, this test would also pass on a build
      // where the claim endpoint were broken outright.
      const { ticket: fresh } = await proveNewAddress(addr());
      const good = uni();
      expect((await claim({ slug: good }, `signup-ticket=${fresh}`)).status).toBe(200);
      expect(await claimerOf(good)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a BODY-SUPPLIED address is ignored — the ticket names the claimer', async () => {
    const person = addr();
    const victim = addr();
    const { ticket } = await proveNewAddress(person);

    const slug = uni();
    const resp = await claim({ slug, email: victim }, `signup-ticket=${ticket}`);
    expect(resp.status).toBe(200);
    // ⚠️ The claimer is the assertion, never the status. A build that read the body would answer 200
    // too — and hand a workspace to an address that never asked for one, in the victim's name.
    expect(await claimerOf(slug)).toBe(person);
    expect(await claimerOf(slug)).not.toBe(victim);

    // ⚠️ **A CONTRACT guard, not a behavioural one — no mutation isolates it, and saying so is the
    // point.** `claimUniverseWithTicket(ticketHash, slug)` takes no address argument at all, so the
    // property holds by the signature rather than by a check that could be removed. This assertion
    // exists to red if someone later threads an address through, which is exactly when it would
    // stop holding.
  });

  it('the ticket buys nothing at the ACCEPT endpoint — it is spendable only at the claim', async () => {
    const person = addr();
    const { ticket } = await proveNewAddress(person);
    const owner = await foundUniverse(SELF, uni(), addr());
    const scope = owner.parsed.access.authScope;

    // Present the ticket where a refresh cookie belongs. It is not that credential and must not be
    // mistaken for one — reds if the accept handler ever grew a ticket branch.
    const resp = await SELF.fetch(new Request(url(scope, 'accept-membership'), {
      method: 'POST',
      headers: { Cookie: `signup-ticket=${ticket}`, 'Content-Type': 'application/json' },
    }));
    expect(resp.status).toBe(401);
  });

  it('a slug already taken by SOMEONE ELSE still conflicts', async () => {
    const taken = uni();
    await foundUniverse(SELF, taken, addr()); // claimed by a different person entirely
    const { ticket } = await proveNewAddress(addr());
    const resp = await claim({ slug: taken }, `signup-ticket=${ticket}`);
    expect(resp.status).toBe(409);
  });

  it('the SAME slug submitted twice by its own claimer resolves instead of conflicting', async () => {
    // ⚠️ **Both tickets are taken BEFORE either claim**, and the fixture does not work otherwise:
    // once the first claim lands the address holds a membership, so a later click mints a session
    // and never reaches the zero-membership arm that issues tickets. That is also what makes this
    // branch reachable at all — two tabs, two links clicked, the same workspace name typed in both.
    const person = addr();
    const slug = uni();
    const { ticket: first } = await proveNewAddress(person);
    const { ticket: second } = await proveNewAddress(person);

    expect((await claim({ slug }, `signup-ticket=${first}`)).status).toBe(200);
    // A bare conflict here would tell a brand-new user their workspace is already claimed — by
    // themselves. Reds against dropping the same-address resume branch.
    const again = await claim({ slug }, `signup-ticket=${second}`);
    expect(again.status).toBe(200);
    expect(await claimerOf(slug)).toBe(person);
  });
});

describe('Phase 6 — `expectNoSession` can actually fail', () => {
  it('passes on a ticket-only response and FAILS on one carrying a session', async () => {
    // ⚠️ This exists because the helper replaced five `Set-Cookie === null` assertions across three
    // files, and a helper that never throws would have turned all five green while asserting
    // nothing — the silent no-op `testing.md` § *An INSTRUMENT is an assertion too* is about. So:
    // point it at both shapes and check it discriminates.
    const req = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: addr() }),
    }));
    const { magicLinkUrl } = await req.json() as { magicLinkUrl: string };
    const ticketOnly = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    expect(() => expectNoSession(ticketOnly)).not.toThrow(); // a ticket is not a session

    // A real login, which sets a refresh cookie — the helper must reject this one.
    const founded = await foundUniverse(SELF, uni(), addr());
    const withSession = await SELF.fetch(new Request(url(founded.parsed.access.authScope, 'refresh-token'), {
      method: 'POST',
      headers: { Cookie: `refresh-token=${founded.refreshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: founded.parsed.access.authScope }),
    }));
    const sessionish = new Response(null, {
      headers: { 'Set-Cookie': `refresh-token=${founded.refreshToken}; Path=/auth/x` },
    });
    expect(withSession.status).toBe(200); // the fixture is real, not hand-waved
    expect(() => expectNoSession(sessionish)).toThrow();
  });
});

describe('Phase 6 — the coming-soon route records a closed set of tags', () => {
  let entries: any[] = [];
  beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e)); });
  afterEach(() => { clearDebugSink(); });

  const post = (body: unknown) => SELF.fetch(new Request('https://example.com/auth/coming-soon', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

  it('a known tag answers 204 and reaches the log', async () => {
    const resp = await post({ tag: COMING_SOON_TAGS[0] });
    expect(resp.status).toBe(204);
    const logged = entries.filter((e) => e.namespace === 'nebula-auth.comingSoon');
    expect(logged).toHaveLength(1);
    expect(logged[0].data).toMatchObject({ tag: COMING_SOON_TAGS[0] });
  });

  it('an UNKNOWN tag is refused rather than logged', async () => {
    const resp = await post({ tag: 'whatever-the-client-felt-like' });
    expect(resp.status).toBe(400);
    // ⚠️ Both halves. Refusing while still writing the line would leave the log-injection faucet
    // wide open, and a status-only assertion cannot tell the two apart.
    expect(entries.filter((e) => e.namespace === 'nebula-auth.comingSoon')).toHaveLength(0);
  });

  it('a missing tag is refused', async () => {
    expect((await post({})).status).toBe(400);
    expect(entries.filter((e) => e.namespace === 'nebula-auth.comingSoon')).toHaveLength(0);
  });
});
