/**
 * Live self-verification harness — PROD drive (3b + 3d + attach, consolidated).
 *
 * Drives the *deployed* Nebula at `nebula.lumenize.com` (no local boot). The Turnstile gate on the
 * unauthenticated endpoints is skipped via the authorized bypass token
 * (`NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`, presented as the `x-lumenize-turnstile-bypass` header) —
 * used ONLY for the one-time login, since `refresh-token` / `my-scopes` / resource reads are already
 * Turnstile-free. The login seeds a **stored refresh token** (Phase 3d) so subsequent runs refresh
 * headlessly. The refresh token is a `*`-admin credential — kept in a gitignored file, NEVER logged.
 *
 * @see tasks/archive/claude-live-verification.md — Phase 3b/3d
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDevVar } from './harness';
// Reuse the ui-smoke email loop (Node-safe, filters by scope) to catch the magic-link.
import { waitForEmail, extractMagicLink } from '../../test/browser/auth-bootstrap';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
/** Gitignored `*`-admin refresh-token store (M1: never committed, never logged). */
const SESSION_FILE = resolve(HARNESS_DIR, '.prod-session.json');
/** The deployed origin. Override with NEBULA_PROD_URL. */
export const PROD_URL = (process.env.NEBULA_PROD_URL ?? 'https://nebula.lumenize.com').replace(/\/$/, '');
const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';
/** The platform instance — a login here mints an `access.authScopePattern: '*'` (super-admin) token. */
export const PLATFORM_SCOPE = 'nebula-platform';
/** The harness identity (must be an `@lumenize.io` address routed to the email-test Worker). */
export const HARNESS_EMAIL = process.env.HARNESS_LOGIN_EMAIL ?? 'claude@lumenize.io';

interface ProdSession {
  /** The refresh-token cookie value — a `*`-admin credential. */
  refreshToken: string;
  /** The authScope the refresh cookie is bound to (its Path). */
  authScope: string;
  email: string;
  savedAt: string;
}

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

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

/**
 * One-time login: POST email-magic-link WITH the Turnstile-bypass header → catch the magic-link via
 * the email-test Worker → GET it to obtain the `refresh-token` cookie. Stores + returns the session.
 * Requires the harness identity (`HARNESS_EMAIL`) to be routed to the email-test Worker.
 */
export async function prodLogin(authScope = PLATFORM_SCOPE, email = HARNESS_EMAIL): Promise<ProdSession> {
  const bypassToken = readDevVar('NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN');
  const testToken = readDevVar('TEST_TOKEN');
  const waiter = waitForEmail({ testToken, instance: authScope, timeout: 120_000 });
  try {
    const res = await fetch(`${PROD_URL}/auth/${authScope}/email-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BYPASS_HEADER]: bypassToken },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      // A 403 here means the bypass token didn't take (not deployed / wrong value) — Turnstile blocked us.
      throw new Error(`email-magic-link ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const link = extractMagicLink(await waiter.emailPromise);
    const linkRes = await fetch(link, { redirect: 'manual' }); // 302 + Set-Cookie(refresh-token)
    const refreshToken = cookieValue(linkRes.headers.getSetCookie?.() ?? [], 'refresh-token');
    if (!refreshToken) {
      throw new Error(`magic-link GET (${linkRes.status}) set no refresh-token cookie`);
    }
    const session: ProdSession = { refreshToken, authScope, email, savedAt: new Date().toISOString() };
    writeSession(session);
    return session;
  } finally {
    waiter.cleanup();
  }
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
  const waiter = waitForEmail({ testToken, instance: authScope, timeout: 120_000 });
  try {
    const res = await fetch(`${PROD_URL}/auth/${authScope}/email-magic-link`, {
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
  const res = await fetch(`${PROD_URL}/auth/${session.authScope}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${session.refreshToken}` },
    body: JSON.stringify({ activeScope }),
  });
  if (!res.ok) throw new Error(`refresh-token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
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

/** POST /auth/my-scopes with a `*` token → the full scope tree (all Universes) the admin can reach. */
export async function prodEnumerate(accessToken: string): Promise<unknown> {
  const res = await fetch(`${PROD_URL}/auth/my-scopes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(`my-scopes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { scopes: unknown }).scopes;
}
