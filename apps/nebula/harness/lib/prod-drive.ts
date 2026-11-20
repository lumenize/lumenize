/**
 * Live self-verification harness — PROD drive (3b + 3d + attach, consolidated).
 *
 * Drives the *deployed* Lumenize at `lumenize.dev` (no local boot), on the platform host as a browser
 * does. The Turnstile gate on the unauthenticated endpoints is skipped via the authorized bypass
 * token (`AUTH_TURNSTILE_BYPASS_TOKEN`, presented as the `x-lumenize-turnstile-bypass`
 * header) — used ONLY for the one-time login, since the refresh, Home's summary and resource reads
 * are already Turnstile-free. The login seeds a **stored cookie jar** (Phase 3d): the platform host's
 * refresh cookies, so later runs refresh headlessly. Those cookies are a superuser credential — kept
 * in a gitignored file, NEVER logged.
 *
 * ⚠️ **This targets the POST-WIPE deployment**, like everything else on this branch: today's prod
 * still runs the pre-wipe build, on another host. That is not a regression to fix here — it is what
 * the wipe gate is for.
 *
 * @see tasks/archive/claude-live-verification.md — Phase 3b/3d
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { hostOrigin } from '@lumenize/mesh/client';
import { readDevVar } from './harness';
// The real-login flow itself is shared with the vitest lanes (rung 1, ADR-009) —
// this module adds only what is prod-specific: the stored cookie jar.
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { loginViaEmail } from '../../test/lib/email-login';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
/** Gitignored superuser cookie store (M1: never committed, never logged). */
const SESSION_FILE = resolve(HARNESS_DIR, '.prod-session.json');
/** The deployment's origin, whose hosts the drive spells. Override with `LUMENIZE_PROD_ORIGIN`. */
export const PROD_ORIGIN = (process.env.LUMENIZE_PROD_ORIGIN ?? 'https://lumenize.dev').replace(/\/$/, '');
/** The platform host, where every session lives (ADR-022). */
export const PROD_URL = hostOrigin({ kind: 'platform' }, PROD_ORIGIN, PROD_ORIGIN);
const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';
/** The reserved platform scope — the ROOT of the scope tree, so a membership here has dominion
 *  everywhere. It names no host: its cookie mints on whichever scope's page asks. */
export const PLATFORM_SCOPE = '_platform';
/** The harness identity. It must reach the email-test Worker: `claude@lumenize.io` has its own
 *  Email Routing rule, and any `@lumenize-test.dev` address rides that domain's catch-all. */
export const HARNESS_EMAIL = process.env.HARNESS_LOGIN_EMAIL ?? 'claude@lumenize.io';

/** One stored cookie, as the jar holds it; `expires` round-trips as an ISO string. */
type StoredCookie = ReturnType<Browser['getAllCookies']>[number];

/** A browser holding the stored platform-host cookies, or `null` when none are stored. */
function readSession(): Browser | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const cookies = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as StoredCookie[];
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    const browser = new Browser();
    for (const { name, value, expires, sameSite, ...rest } of cookies) {
      browser.setCookie(name, value, {
        ...rest, hostOnly: true,
        ...(expires ? { expires: new Date(expires) } : {}),
        ...(sameSite ? { sameSite: sameSite as 'Strict' | 'Lax' | 'None' } : {}),
      });
    }
    return browser;
  } catch {
    return null;
  }
}

function writeSession(browser: Browser): void {
  const host = new URL(PROD_URL).hostname;
  writeFileSync(SESSION_FILE, JSON.stringify(browser.getAllCookies().filter((c) => c.domain === host), null, 2));
}

/**
 * One-time login on the platform host: request a link WITH the Turnstile-bypass header → catch it via
 * the email-test Worker → press its page's Continue → accept the membership on Home. Stores the jar
 * and returns the browser holding it. Requires `HARNESS_EMAIL` to be routed to the email-test Worker.
 */
export async function prodLogin(authScope = PLATFORM_SCOPE, email = HARNESS_EMAIL): Promise<Browser> {
  const browser = new Browser();
  await loginViaEmail({
    baseUrl: PROD_URL,
    authScope,
    email,
    testToken: readDevVar('TEST_TOKEN'),
    bypassToken: readDevVar('AUTH_TURNSTILE_BYPASS_TOKEN'),
    timeout: 120_000,
    fetchImpl: browser.fetch,
  });
  writeSession(browser);
  return browser;
}

/**
 * Catch-all health check: request a magic link for a FRESH, unruled `@lumenize-test.dev` address and confirm
 * the email-test Worker receives it — proving `*@lumenize-test.dev` catch-all → email-test Worker routes.
 * **Request-only** — does NOT consume the link, so no subject is created (the link expires unused).
 * Returns the received magic-link URL (proof of routing). First bit of the ADR-009 real-login harness.
 */
export async function prodEmailSpin(email: string): Promise<string> {
  const bypassToken = readDevVar('AUTH_TURNSTILE_BYPASS_TOKEN');
  const testToken = readDevVar('TEST_TOKEN');
  // ⚠️ `_scopeless` — the login request names no scope, so its mail carries no scope tag.
  const waiter = waitForEmail({ testToken, instance: '_scopeless', to: email, timeout: 120_000 });
  try {
    const res = await fetch(`${PROD_URL}/auth/email-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BYPASS_HEADER]: bypassToken },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(`email-magic-link ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return extractMagicLink(await waiter.emailPromise); // NOT consumed — no subject created
  } finally {
    waiter.cleanup();
  }
}

/**
 * The stored browser, or a fresh login when none is stored or its cookies no longer reach Home's
 * summary. This is the autonomous entry — no human, no per-request credentialing.
 */
export async function prodSession(): Promise<Browser> {
  const stored = readSession();
  if (stored) {
    const probe = await homeSummary(stored);
    if (probe.ok) return stored;
    // The cookies lapsed or were revoked → fall through to a fresh login.
    console.error(`[prod] stored session refused (${probe.status}); re-logging in`);
  }
  return prodLogin();
}

/**
 * Refresh headlessly (NOT Turnstile-gated) as a page on `scope`'s host does → an access token whose
 * `aud` is `scope`. A superuser's root cookie mints on any scope's page.
 */
export async function prodRefresh(browser: Browser, scope: string): Promise<string> {
  const page = hostOrigin({ kind: 'scope', scope }, PROD_ORIGIN, PROD_ORIGIN);
  const res = await browser.context(page).fetch(`${PROD_URL}/auth/refresh-token`, { method: 'POST' });
  if (!res.ok) throw new Error(`refresh-token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** `POST /auth/home-summary` as Home on the platform host sends it. */
function homeSummary(browser: Browser): Promise<Response> {
  return browser.context(PROD_URL).fetch(`${PROD_URL}/auth/home-summary`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
}

/**
 * Home's summary → the tree this login reaches, budget-bounded, one group per Profile.
 *
 * It is `profileId`-keyed and nested, descends only under ACCEPTED admin memberships, and marks what
 * it did not descend into with `childCount` rather than reading it. A caller wanting past that
 * frontier asks the facade's `expandScope`, from that scope's page.
 */
export async function prodEnumerate(browser: Browser): Promise<unknown> {
  const res = await homeSummary(browser);
  if (!res.ok) throw new Error(`home-summary ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { groups: unknown }).groups;
}
