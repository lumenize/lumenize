/**
 * Phase 6: which routes carry Turnstile, derived from what CREDENTIAL each one presents.
 *
 * Turnstile was accumulated route by route, and "does this row have it?" was answered by looking at
 * its neighbours. That is how a gate ends up on a route that never needed one and missing from a
 * route that did. The rule underneath it is short:
 *
 *   **A route that presents no credential of any kind — no Bearer token, no path-scoped cookie, no
 *   one-time token from an email — carries `turnstileGuard`.** Everything else does not, because a
 *   credential already establishes that a human with access to a mailbox is on the other end, and
 *   challenging them a second time is friction we charge for nothing.
 *
 * Two kinds of route are exempt despite presenting nothing, and each says why below: the GETs that
 * serve the auth SPA's static HTML, and the coming-soon demand signal.
 *
 * ⚠️ **The classification table is EXHAUSTIVE, and that is the mechanism.** A route in the real table
 * with no entry here fails this file rather than defaulting either way — so the next person to add a
 * route has to state which side of the line it falls on, which is the decision that kept being made
 * by proximity instead.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildAuthRouteTable } from '../src/router';

/**
 * What each route presents to prove a human is behind it.
 *
 *  - `none`        — nothing at all. Carries Turnstile.
 *  - `bearer`      — a verified access token.
 *  - `cookie`      — a path-scoped refresh cookie, or the signup ticket. Both reached this browser
 *                    only by a click on mail that arrived at the address.
 *  - `one-time`    — a token from an email, in the URL. The token IS the proof.
 *  - `none-exempt` — presents nothing, and is deliberately un-gated. Needs a reason on the line.
 */
type Credential = 'none' | 'bearer' | 'cookie' | 'one-time' | 'none-exempt';

const CLASSIFICATION: Record<string, Credential> = {
  // ── Presents nothing: gated ────────────────────────────────────────────────────────────────────
  'POST /auth/claim-universe': 'none',
  'POST /auth/claim-star': 'none',
  'POST /auth/email-magic-link': 'none',

  // ── Presents a verified access token ───────────────────────────────────────────────────────────
  'POST /auth/scope-summary': 'bearer',
  'POST /auth/expand-scope': 'bearer',
  'POST /auth/create-galaxy': 'bearer',
  'POST /auth/create-star': 'bearer',
  'POST /auth/delete-scope': 'bearer',
  'POST /auth/delete-scope-plan': 'bearer',
  'POST /auth/mint-narrower-token': 'bearer',

  // ── Presents a cookie that a proved mailbox put there ──────────────────────────────────────────
  'POST /auth/:scope/refresh-token': 'cookie',
  'POST /auth/:scope/accept-membership': 'cookie',
  // The consent modal's inputs, for a membership with no session yet. Same cookie, same server-side
  // re-resolution as accept — it answers about the membership the COOKIE names, never the URL's.
  'POST /auth/:scope/pending-membership': 'cookie',
  'POST /auth/:scope/logout': 'cookie',
  'POST /auth/:scope/logout-all': 'cookie',
  'POST /auth/signup': 'cookie', // the signup ticket, issued to a click minutes earlier

  // ── Presents a one-time token from an email ────────────────────────────────────────────────────
  'GET /auth/magic-link': 'one-time',
  'GET /auth/:scope/magic-link': 'one-time',
  'GET /auth/:scope/accept-invite': 'one-time',

  // ── Presents nothing, deliberately un-gated ────────────────────────────────────────────────────
  // Serving static HTML mints nothing, sends nothing, and never reaches the singleton — the assets
  // layer answers. A challenge before a page can render would gate the login form itself.
  'GET /auth/login': 'none-exempt',
  'GET /auth/signup': 'none-exempt',
  'GET /auth/emails': 'none-exempt',
  'GET /auth/:scope/home': 'none-exempt',
  // Writes one log line from a closed enum and answers 204. Nothing is minted, sent or stored, so a
  // Turnstile interaction would cost a real human a puzzle to protect nothing; the connection
  // limiter is what bounds it.
  'POST /auth/coming-soon': 'none-exempt',
};

const key = (r: { method?: string; path: string }) => `${r.method ?? 'ANY'} ${r.path}`;
const carriesTurnstile = (r: { steps: readonly unknown[] }) =>
  r.steps.some((s) => (s as { name?: string }).name === 'turnstileGuard');

describe('Phase 6 — Turnstile placement is derived from the credential, not from neighbours', () => {
  const table = buildAuthRouteTable(env as any);

  it('the instrument can see Turnstile at all', () => {
    // ⚠️ The whole file reads `steps[].name`, which a bundler could rename — in which case every
    // assertion below would pass by finding nothing, everywhere. This anchors it: a route we know is
    // gated must be seen as gated, so a silent no-op fails here first.
    const anchor = table.find((r) => key(r) === 'POST /auth/claim-universe')!;
    expect(anchor, 'claim-universe must exist for this file to mean anything').toBeDefined();
    expect(carriesTurnstile(anchor)).toBe(true);
  });

  it('every route is classified — an unclassified one is a decision nobody made', () => {
    const unclassified = table.map(key).filter((k) => !(k in CLASSIFICATION));
    expect(unclassified, `classify these in CLASSIFICATION, with a reason if 'none-exempt': ${unclassified.join(', ')}`)
      .toEqual([]);
  });

  it('the classification names no route that has been removed', () => {
    const live = new Set(table.map(key));
    // Keeps the table from rotting into a list of routes that no longer exist, which is how an
    // exhaustive check quietly stops being exhaustive.
    expect(Object.keys(CLASSIFICATION).filter((k) => !live.has(k))).toEqual([]);
  });

  it('a route presenting NO credential carries Turnstile', () => {
    const missing = table
      .filter((r) => CLASSIFICATION[key(r)] === 'none')
      .filter((r) => !carriesTurnstile(r))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('a route presenting a credential does NOT carry Turnstile', () => {
    const overGated = table
      .filter((r) => ['bearer', 'cookie', 'one-time', 'none-exempt'].includes(CLASSIFICATION[key(r)]))
      .filter(carriesTurnstile)
      .map(key);
    // Reds if Turnstile is ever added to a cookie route or to coming-soon — the over-gating half,
    // which nothing else in the suite would notice because an extra challenge breaks no test.
    expect(overGated).toEqual([]);
  });

  /**
   * 🔒 **No unauthenticated route answers a question about an address.**
   *
   * This is the property the whole prove-then-choose design exists to establish, and it is stated
   * over the TABLE rather than as an endpoint list, so a future route inherits it instead of being
   * forgotten. Every route reachable without a credential does one of four things — mints a scope,
   * sends mail to an address, serves static HTML, or writes a log line — and crucially, **none of
   * them RETURNS anything derived from which address was named.**
   *
   * `discover` was the exception and is retired: it answered, to anyone, which scopes an address
   * belonged to and which it administered. At galaxy and universe tiers a membership generally IS
   * administration, and at `nebula-platform` it is superuser-ship, so narrowing its response could
   * never have closed it.
   *
   * The behavioural half — that a link request answers a member, a stranger and a bootstrap address
   * identically — is `scopeless-request-and-stamps.test.ts`. Neither half is sufficient alone: this
   * one cannot see what a handler returns, and that one cannot see a NEW route.
   */
  it('no un-credentialed route is a READ — each one mints, sends, serves, or logs', () => {
    const EFFECT: Record<string, 'mints' | 'sends' | 'serves' | 'logs'> = {
      'POST /auth/claim-universe': 'mints',
      'POST /auth/claim-star': 'mints',
      'POST /auth/email-magic-link': 'sends',
      'POST /auth/coming-soon': 'logs',
      'GET /auth/login': 'serves',
      'GET /auth/signup': 'serves',
      'GET /auth/emails': 'serves',
      'GET /auth/:scope/home': 'serves',
    };
    const unCredentialed = table
      .map(key)
      .filter((k) => CLASSIFICATION[k] === 'none' || CLASSIFICATION[k] === 'none-exempt');

    // Every un-credentialed route has a declared effect, and the declaration is what a reviewer
    // reads. A new one with no entry fails here — which is the moment to ask whether it is a READ.
    const undeclared = unCredentialed.filter((k) => !(k in EFFECT));
    expect(undeclared, `declare the EFFECT of these un-credentialed routes: ${undeclared.join(', ')}`)
      .toEqual([]);
    expect(unCredentialed.length).toBeGreaterThan(0); // not vacuous
  });

  it('the un-gated exemptions are the FIVE we argued for, and no others', () => {
    // A count is a weak check, but the point here is that `none-exempt` is the one value someone can
    // reach for to silence this file. Growing the set should require editing this line and saying so.
    const exempt = Object.entries(CLASSIFICATION).filter(([, v]) => v === 'none-exempt').map(([k]) => k);
    expect(exempt.sort()).toEqual([
      'GET /auth/:scope/home',
      'GET /auth/emails',
      'GET /auth/login',
      'GET /auth/signup',
      'POST /auth/coming-soon',
    ]);
  });
});
