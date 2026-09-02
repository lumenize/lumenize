/**
 * Live self-verification harness — PROD drive (3b + 3d + attach, consolidated).
 *
 * Drives the *deployed* Nebula at `nebula.lumenize.com` (no local boot). The Turnstile gate on the
 * unauthenticated endpoints is skipped via the authorized bypass token
 * (`NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`, presented as the `x-lumenize-turnstile-bypass` header) —
 * used ONLY for the one-time login, since `refresh-token` / `scope-summary` / resource reads are already
 * Turnstile-free. The login seeds a **stored refresh token** (Phase 3d) so subsequent runs refresh
 * headlessly. The refresh token is a `*`-admin credential — kept in a gitignored file, NEVER logged.
 *
 * @see tasks/archive/claude-live-verification.md — Phase 3b/3d
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDevVar } from './harness';
// The real-login flow itself is shared with the vitest lanes (rung 1, ADR-009) —
// this module adds only what is prod-specific: the stored-session cache.
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { loginViaEmail, refreshAccessToken, type EmailSession } from '../../test/lib/email-login';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
/** Gitignored `*`-admin refresh-token store (M1: never committed, never logged). */
const SESSION_FILE = resolve(HARNESS_DIR, '.prod-session.json');
/** The deployed origin. Override with NEBULA_PROD_URL. */
export const PROD_URL = (process.env.NEBULA_PROD_URL ?? 'https://nebula.lumenize.com').replace(/\/$/, '');
const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';
/** The reserved platform scope — a login here mints an `access.authScope: 'nebula-platform'` token,
 *  whose dominion is global because that scope is the ROOT of the scope tree. */
export const PLATFORM_SCOPE = 'nebula-platform';
/** The harness identity (must be an `@lumenize.io` address routed to the email-test Worker). */
export const HARNESS_EMAIL = process.env.HARNESS_LOGIN_EMAIL ?? 'claude@lumenize.io';

/** A stored `*`-admin session. Shape is `EmailSession`; the alias keeps prod call sites readable. */
type ProdSession = EmailSession;

function readSession(): ProdSession | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as ProdSession;
  } catch {
    return null;
  }
}

function writeSession(s: ProdSession): void {
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

/**
 * One-time login: POST email-magic-link WITH the Turnstile-bypass header → catch the magic-link via
 * the email-test Worker → GET it to obtain the `refresh-token` cookie. Stores + returns the session.
 * Requires the harness identity (`HARNESS_EMAIL`) to be routed to the email-test Worker.
 */
export async function prodLogin(authScope = PLATFORM_SCOPE, email = HARNESS_EMAIL): Promise<ProdSession> {
  const session = await loginViaEmail({
    baseUrl: PROD_URL,
    authScope,
    email,
    testToken: readDevVar('TEST_TOKEN'),
    bypassToken: readDevVar('NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN'),
    timeout: 120_000,
  });
  writeSession(session);
  return session;
}

/**
 * Catch-all health check: request a magic link for a FRESH, unruled `@lumenize.io` address and confirm
 * the email-test Worker receives it — proving `*@lumenize.io` catch-all → email-test Worker routes.
 * **Request-only** — does NOT consume the link, so no subject is created (the link expires unused).
 * Returns the received magic-link URL (proof of routing). First bit of the ADR-009 real-login harness.
 */
export async function prodEmailSpin(email: string, authScope = PLATFORM_SCOPE): Promise<string> {
  const bypassToken = readDevVar('NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN');
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

/** Refresh headlessly (NOT Turnstile-gated) → an access token whose `aud` is `activeScope`. */
export async function prodRefresh(session: ProdSession, activeScope: string): Promise<string> {
  return (await refreshAccessToken(PROD_URL, session, activeScope)).accessToken;
}

/**
 * Get a valid access token for `activeScope`: refresh the stored session if present, else log in once
 * (bypass + email) and store. This is the autonomous entry — no human, no per-request credentialing.
 */
export async function prodAccessToken(activeScope = PLATFORM_SCOPE): Promise<string> {
  const stored = readSession();
  if (stored) {
    try {
      return await prodRefresh(stored, activeScope);
    } catch (e) {
      // Refresh token lapsed/revoked → fall through to a fresh login.
      console.error(`[prod] stored session refresh failed (${(e as Error).message.slice(0, 120)}); re-logging in`);
    }
  }
  const session = await prodLogin();
  return prodRefresh(session, activeScope);
}

/**
 * POST /auth/scope-summary → the tree this admin reaches, budget-bounded.
 *
 * ⚠️ **Was `my-scopes`, which no longer exists.** That route returned a FLAT list with an unbounded
 * platform arm — a superuser's call read every scope in the table. `scope-summary` is `profileId`-
 * keyed and nested, descends only under ACCEPTED admin memberships, and marks what it did not
 * descend into with `childCount` rather than reading it. A caller wanting past that frontier asks
 * `expand-scope`.
 *
 * ⚠️ **This targets the POST-WIPE deployment**, like everything else on this branch: today's prod
 * still runs the pre-wipe build, where this route does not exist and `my-scopes` does. That is not a
 * regression to fix here — it is what the wipe gate is for.
 */
export async function prodEnumerate(accessToken: string): Promise<unknown> {
  const res = await fetch(`${PROD_URL}/auth/scope-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`scope-summary ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { emails: unknown }).emails;
}
