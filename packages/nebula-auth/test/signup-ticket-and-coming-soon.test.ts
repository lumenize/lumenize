/**
 * The fallback signup page's authorization, and the coming-soon demand signal.
 *
 * The signup ticket exists because of an asymmetry in the newbie path. Someone who declares
 * themselves new uses the login form's "Create a new account" affordance and never gets here.
 * Someone who does not — who just types their address in — proves their mailbox and arrives with
 * nothing to enter. Sending a *second* email so they can claim an account is precisely the
 * interaction this design was built to delete, so the click that proved the address issues a ticket
 * instead, and the signup page spends it.
 *
 * That makes the ticket a credential, and the tests below are mostly about what it must NOT buy:
 *
 *  - **It is spendable only at the claim.** Not at a magic-link request, not at an accept.
 *  - **It carries the address.** A body-supplied one is ignored, because otherwise anyone holding
 *    any ticket could claim an account in someone else's name.
 *  - **It expires.** Minutes, not the magic link's half hour — the screen it authorizes is the very
 *    next navigation.
 *
 * The coming-soon route is here because it is the other unauthenticated route added beside the
 * ticket, and its one real property is that its tag is a closed set rather than free text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import {
  foundUniverse, expectNoSession, cookieValue, proveNewAddress as proveAddress, authUrl, consumeLink,
  requestMagicLink, refresh, refreshCookie,
} from './test-helpers';
import { SIGNUP_TICKET_TTL, SIGNUP_TICKET_COOKIE, COMING_SOON_TAGS } from '../src/types';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p6-${crypto.randomUUID().slice(0, 8)}@example.com`;
const getRegistry = (): any => env.AUTH_REGISTRY.getByName('registry');

const proveNewAddress = (email: string) => proveAddress(SELF, email);

/** POST the signup page's claim with an explicit cookie header. The form posts the first app's slug
 *  beside the account's, so this does too unless a case names its own. */
function claim(body: Record<string, unknown>, cookie?: string): Promise<Response> {
  return SELF.fetch(new Request(authUrl('signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ appSlug: 'first', ...body }),
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

describe('the signup ticket authorizes the signup page, and nothing else', () => {
  it('a new address lands on signup with a ticket, and spends it to claim in ONE step', async () => {
    const person = addr();
    const { ticket, location } = await proveNewAddress(person);
    expect(location).toBe('/auth/signup'); // nothing to enter, so not a Home screen

    const slug = uni();
    const resp = await claim({ slug }, `${SIGNUP_TICKET_COOKIE}=${ticket}`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ scope: slug, redirect: '/' });

    // The claim logged them in directly — the whole point of the ticket is that no SECOND email is
    // sent, so a refresh cookie must come back from this very response.
    expect(cookieValue(resp, `__Host-refresh-token.${slug}`)).toBeDefined();
    expect(await claimerOf(slug)).toBe(person);
  });

  it('the ticket is SINGLE-USE — replaying it claims nothing', async () => {
    const { ticket } = await proveNewAddress(addr());
    expect((await claim({ slug: uni() }, `${SIGNUP_TICKET_COOKIE}=${ticket}`)).status).toBe(200);

    const second = uni();
    const replay = await claim({ slug: second }, `${SIGNUP_TICKET_COOKIE}=${ticket}`);
    expect(replay.status).toBe(403);
    // The refusal is the assertion only if nothing was written — a 403 with a claimed scope behind
    // it would be worse than no check at all.
    expect(await claimerOf(second)).toBeNull();
  });

  it('an UNRECOGNISED ticket is refused', async () => {
    const slug = uni();
    const resp = await claim({ slug }, `${SIGNUP_TICKET_COOKIE}=not-a-real-ticket-value-at-all`);
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
      const expired = await claim({ slug: stale }, `${SIGNUP_TICKET_COOKIE}=${ticket}`);
      expect(expired.status).toBe(403);
      expect(await claimerOf(stale)).toBeNull();

      // Positive control at the SAME clock reading: without it, this test would also pass on a build
      // where the claim endpoint were broken outright.
      const { ticket: fresh } = await proveNewAddress(addr());
      const good = uni();
      expect((await claim({ slug: good }, `${SIGNUP_TICKET_COOKIE}=${fresh}`)).status).toBe(200);
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
    const resp = await claim({ slug, email: victim }, `${SIGNUP_TICKET_COOKIE}=${ticket}`);
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
    const resp = await SELF.fetch(new Request(authUrl('accept-membership'), {
      method: 'POST',
      headers: { Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    }));
    expect(resp.status).toBe(401);
  });

  it('a slug already taken by SOMEONE ELSE still conflicts', async () => {
    const taken = uni();
    await foundUniverse(SELF, taken, addr()); // claimed by a different person entirely
    const { ticket } = await proveNewAddress(addr());
    const resp = await claim({ slug: taken }, `${SIGNUP_TICKET_COOKIE}=${ticket}`);
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

    expect((await claim({ slug }, `${SIGNUP_TICKET_COOKIE}=${first}`)).status).toBe(200);
    // A bare conflict here would tell a brand-new user their workspace is already claimed — by
    // themselves. Reds against dropping the same-address resume branch.
    const again = await claim({ slug }, `${SIGNUP_TICKET_COOKIE}=${second}`);
    expect(again.status).toBe(200);
    expect(await claimerOf(slug)).toBe(person);
  });
});

describe('`expectNoSession` can actually fail', () => {
  it('passes on a ticket-only response and FAILS on one carrying a session', async () => {
    // ⚠️ This exists because the helper replaced five `Set-Cookie === null` assertions across three
    // files, and a helper that never throws would have turned all five green while asserting
    // nothing — the silent no-op `testing.md` § *An INSTRUMENT is an assertion too* is about. So:
    // point it at both shapes and check it discriminates.
    const req = await requestMagicLink(SELF, addr());
    const { magicLinkUrl } = await req.json() as { magicLinkUrl: string };
    const ticketOnly = await consumeLink(SELF, magicLinkUrl);
    expect(() => expectNoSession(ticketOnly)).not.toThrow(); // a ticket is not a session

    // A real login, which sets a refresh cookie — the helper must reject this one.
    const founded = await foundUniverse(SELF, uni(), addr());
    const scope = founded.parsed.access.authScope;
    const withSession = await refresh(SELF, scope, refreshCookie(scope, founded.refreshToken));
    const sessionish = new Response(null, {
      headers: { 'Set-Cookie': `${refreshCookie(scope, founded.refreshToken)}; Path=/; HttpOnly; Secure; SameSite=Lax` },
    });
    expect(withSession.status).toBe(200); // the fixture is real, not hand-waved
    expect(() => expectNoSession(sessionish)).toThrow();
  });
});

describe('the coming-soon route records a closed set of tags', () => {
  let entries: any[] = [];
  beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e)); });
  afterEach(() => { clearDebugSink(); });

  const post = (body: unknown) => SELF.fetch(new Request(authUrl('coming-soon'), {
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
