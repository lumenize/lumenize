import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { routeDORequest, type CorsOptions } from '@lumenize/utils';
import { ALL_SCHEMAS } from './schemas';
import type { Subject, MagicLink, RefreshToken, LoginResponse, AuthError, AuthRoutesOptions, EmailService } from './types';
import {
  generateRandomString,
  generateUuid,
  hashString,
  signJwt,
  importPrivateKey,
  createJwtPayload
} from './jwt';
import { ConsoleEmailService } from './email-service';

/**
 * SQL template literal tag for Durable Object storage.
 * Copied from @lumenize/mesh/src/sql.ts (originally from @cloudflare/actors).
 */
function sql(doInstance: any) {
  const ctx = doInstance.ctx;
  return (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) =>
      acc + str + (i < values.length ? '?' : ''), '');
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

/**
 * LumenizeAuth - Durable Object for authentication
 *
 * Provides magic link login, JWT access tokens, and refresh token rotation.
 * All configuration is read from environment variables (no RPC config needed).
 *
 * @see https://lumenize.com/docs/auth/
 */
export class LumenizeAuth extends DurableObject {
  #debug = debug(this);
  #sql = sql(this);
  #schemaInitialized = false;
  #emailService: EmailService = new ConsoleEmailService();

  /**
   * Ensure database schema is created
   */
  #ensureSchema(): void {
    if (this.#schemaInitialized) return;
    for (const schema of ALL_SCHEMAS) {
      this.ctx.storage.sql.exec(schema);
    }
    this.#schemaInitialized = true;
  }

  /**
   * Set the email service implementation
   */
  setEmailService(service: EmailService): void {
    this.#emailService = service;
  }

  // ============================================
  // Environment-based config helpers
  // ============================================

  get #redirect(): string { return (this.env as any).LUMENIZE_AUTH_REDIRECT; }
  get #issuer(): string { return (this.env as any).LUMENIZE_AUTH_ISSUER || 'https://lumenize.local'; }
  get #audience(): string { return (this.env as any).LUMENIZE_AUTH_AUDIENCE || 'https://lumenize.local'; }
  get #accessTokenTtl(): number { return Number((this.env as any).LUMENIZE_AUTH_ACCESS_TOKEN_TTL) || 900; }
  get #refreshTokenTtl(): number { return Number((this.env as any).LUMENIZE_AUTH_REFRESH_TOKEN_TTL) || 2592000; }
  get #magicLinkTtl(): number { return Number((this.env as any).LUMENIZE_AUTH_MAGIC_LINK_TTL) || 1800; }
  get #prefix(): string { return (this.env as any).LUMENIZE_AUTH_PREFIX || '/auth'; }

  /**
   * HTTP request handler — routes to appropriate endpoint
   */
  async fetch(request: Request): Promise<Response> {
    // Validate required config
    if (!this.#redirect) {
      return this.#errorResponse(500, 'server_error', 'LUMENIZE_AUTH_REDIRECT not set');
    }

    // Ensure schema exists
    this.#ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;
    const log = this.#debug('auth.LumenizeAuth');

    try {
      if (path.endsWith('/email-magic-link') && request.method === 'POST') {
        return await this.#handleEmailMagicLink(request, url);
      }

      if (path.endsWith('/magic-link') && request.method === 'GET') {
        return await this.#handleMagicLink(request, url);
      }

      if (path.endsWith('/refresh-token') && request.method === 'POST') {
        return await this.#handleRefreshToken(request);
      }

      if (path.endsWith('/logout') && request.method === 'POST') {
        return await this.#handleLogout(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      log.error('Auth error', {
        error: error instanceof Error ? error.message : String(error),
        path,
        method: request.method
      });
      return this.#errorResponse(500, 'server_error', 'Internal server error');
    }
  }

  // ============================================
  // HTTP Endpoint Handlers
  // ============================================

  /**
   * POST {prefix}/email-magic-link — Request a magic link
   */
  async #handleEmailMagicLink(request: Request, url: URL): Promise<Response> {
    let email: string;
    try {
      const body = await request.json() as { email?: string };
      email = body.email?.toLowerCase().trim() || '';
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    if (!email || !this.#isValidEmail(email)) {
      return this.#errorResponse(400, 'invalid_request', 'Valid email required');
    }

    // Generate one-time login token
    const token = generateRandomString(32);
    const expiresAt = Date.now() + (this.#magicLinkTtl * 1000);

    this.#sql`
      INSERT INTO magic_links (token, email, expires_at, used)
      VALUES (${token}, ${email}, ${expiresAt}, 0)
    `;

    // Build magic link URL
    const baseUrl = url.origin;
    const magicLinkUrl = `${baseUrl}${this.#prefix}/magic-link?one_time_token=${token}`;

    // Check for test mode
    const isTestMode = (this.env as any).LUMENIZE_AUTH_TEST_MODE === 'true' && url.searchParams.get('_test') === 'true';

    if (isTestMode) {
      return Response.json({
        message: 'Magic link generated (test mode)',
        magic_link: magicLinkUrl,
        expires_in: this.#magicLinkTtl
      });
    }

    // Send email
    try {
      await this.#emailService.send(email, magicLinkUrl);
    } catch (error) {
      const log = this.#debug('auth.LumenizeAuth');
      log.error('Failed to send magic link email', {
        error: error instanceof Error ? error.message : String(error),
        email
      });
      // Still return success to prevent email enumeration attacks
    }

    return Response.json({
      message: 'Check your email for the magic link',
      expires_in: this.#magicLinkTtl
    });
  }

  /**
   * GET {prefix}/magic-link — Validate magic link and complete login
   */
  async #handleMagicLink(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('one_time_token');

    if (!token) {
      return this.#errorResponse(400, 'invalid_request', 'Missing one_time_token');
    }

    // Look up magic link
    const rows = this.#sql`
      SELECT token, email, expires_at, used
      FROM magic_links
      WHERE token = ${token}
    ` as MagicLink[];

    if (rows.length === 0) {
      return this.#redirectWithError('invalid_token');
    }

    const magicLink = rows[0];

    // Check if already used
    if (magicLink.used) {
      return this.#redirectWithError('token_used');
    }

    // Check expiration
    if (Date.now() > magicLink.expires_at) {
      return this.#redirectWithError('token_expired');
    }

    // Delete the token (single-use)
    this.#sql`DELETE FROM magic_links WHERE token = ${token}`;

    // Get or create subject
    const subject = this.#getOrCreateSubject(magicLink.email);

    // Update last login and set emailVerified
    this.#sql`
      UPDATE subjects
      SET last_login_at = ${Date.now()}, email_verified = 1
      WHERE sub = ${subject.sub}
    `;

    // Generate refresh token
    const refreshToken = await this.#generateRefreshToken(subject.sub);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': this.#redirect,
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken)
      }
    });
  }

  /**
   * POST {prefix}/refresh-token — Exchange refresh token for access token
   */
  async #handleRefreshToken(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');

    if (!refreshToken) {
      return this.#errorResponse(401, 'invalid_token', 'No refresh token provided');
    }

    const tokenHash = await hashString(refreshToken);

    const rows = this.#sql`
      SELECT token_hash, subject_id, expires_at, revoked
      FROM refresh_tokens
      WHERE token_hash = ${tokenHash}
    ` as RefreshToken[];

    if (rows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Invalid refresh token');
    }

    const storedToken = rows[0];

    if (storedToken.revoked) {
      return this.#errorResponse(401, 'token_revoked', 'Refresh token has been revoked');
    }

    if (Date.now() > storedToken.expires_at) {
      return this.#errorResponse(401, 'token_expired', 'Refresh token expired');
    }

    // Revoke old refresh token (rotation)
    this.#sql`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ${tokenHash}`;

    // Look up the subject to get current flags for JWT claims
    const subjectRows = this.#sql`
      SELECT sub, email, email_verified, admin_approved, is_admin, authorized_actors, created_at, last_login_at
      FROM subjects WHERE sub = ${storedToken.subject_id}
    ` as any[];

    if (subjectRows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Subject not found');
    }

    const subject = this.#rowToSubject(subjectRows[0]);

    // Generate new tokens
    const newAccessToken = await this.#generateAccessToken(subject);
    const newRefreshToken = await this.#generateRefreshToken(storedToken.subject_id);

    const response: LoginResponse = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: this.#accessTokenTtl
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': this.#createRefreshTokenCookie(newRefreshToken)
      }
    });
  }

  /**
   * POST {prefix}/logout — Revoke refresh token
   */
  async #handleLogout(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');

    if (refreshToken) {
      const tokenHash = await hashString(refreshToken);
      this.#sql`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ${tokenHash}`;
    }

    return new Response(JSON.stringify({ message: 'Logged out' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'refresh-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      }
    });
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get or create a subject by email
   */
  #getOrCreateSubject(email: string): Subject {
    const normalizedEmail = email.toLowerCase();

    const existingRows = this.#sql`
      SELECT sub, email, email_verified, admin_approved, is_admin, authorized_actors, created_at, last_login_at
      FROM subjects
      WHERE email = ${normalizedEmail}
    ` as any[];

    if (existingRows.length > 0) {
      return this.#rowToSubject(existingRows[0]);
    }

    // Create new subject
    const sub = generateUuid();
    const now = Date.now();

    this.#sql`
      INSERT INTO subjects (sub, email, email_verified, admin_approved, is_admin, authorized_actors, created_at, last_login_at)
      VALUES (${sub}, ${normalizedEmail}, 0, 0, 0, '[]', ${now}, ${now})
    `;

    return {
      sub,
      email: normalizedEmail,
      emailVerified: false,
      adminApproved: false,
      isAdmin: false,
      authorizedActors: [],
      createdAt: now,
      lastLoginAt: now
    };
  }

  /**
   * Convert a SQL row to a Subject object
   */
  #rowToSubject(row: any): Subject {
    return {
      sub: row.sub,
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      adminApproved: Boolean(row.admin_approved),
      isAdmin: Boolean(row.is_admin),
      authorizedActors: JSON.parse(row.authorized_actors || '[]'),
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    };
  }

  /**
   * Generate a signed JWT access token with subject claims
   */
  async #generateAccessToken(subject: Subject): Promise<string> {
    const activeKey = (this.env as any).PRIMARY_JWT_KEY || 'BLUE';
    const privateKeyPem = activeKey === 'GREEN'
      ? (this.env as any).JWT_PRIVATE_KEY_GREEN
      : (this.env as any).JWT_PRIVATE_KEY_BLUE;

    if (!privateKeyPem) {
      throw new Error(`JWT private key not configured for ${activeKey}`);
    }

    const privateKey = await importPrivateKey(privateKeyPem);

    const payload = createJwtPayload({
      issuer: this.#issuer,
      audience: this.#audience,
      subject: subject.sub,
      expiresInSeconds: this.#accessTokenTtl,
      emailVerified: subject.emailVerified,
      adminApproved: subject.adminApproved,
      isAdmin: subject.isAdmin || undefined,
    });

    return signJwt(payload, privateKey, activeKey);
  }

  /**
   * Generate a refresh token and store its hash
   */
  async #generateRefreshToken(subjectId: string): Promise<string> {
    const token = generateRandomString(32);
    const tokenHash = await hashString(token);
    const now = Date.now();
    const expiresAt = now + (this.#refreshTokenTtl * 1000);

    this.#sql`
      INSERT INTO refresh_tokens (token_hash, subject_id, expires_at, created_at, revoked)
      VALUES (${tokenHash}, ${subjectId}, ${expiresAt}, ${now}, 0)
    `;

    return token;
  }

  /**
   * Create a secure cookie for the refresh token
   */
  #createRefreshTokenCookie(token: string): string {
    return `refresh-token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${this.#refreshTokenTtl}`;
  }

  /**
   * Redirect to LUMENIZE_AUTH_REDIRECT with an error query param
   */
  #redirectWithError(error: string): Response {
    const separator = this.#redirect.includes('?') ? '&' : '?';
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${this.#redirect}${separator}error=${error}` }
    });
  }

  /**
   * Extract a cookie value from Cookie header
   */
  #extractCookie(cookieHeader: string, name: string): string | null {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [cookieName, ...rest] = cookie.trim().split('=');
      if (cookieName === name) {
        return rest.join('=');
      }
    }
    return null;
  }

  /**
   * Validate email format
   */
  #isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /**
   * Create an error response
   */
  #errorResponse(status: number, error: string, description: string): Response {
    const body: AuthError = { error, error_description: description };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Creates an auth routes handler that wraps routeDORequest with URL rewriting.
 *
 * All auth configuration (redirect, issuer, audience, TTLs, prefix)
 * is read from environment variables — only Worker-level routing options
 * are passed here.
 *
 * @see https://lumenize.com/docs/auth/api-reference#createauthroutes
 */
export function createAuthRoutes(
  env: Env,
  options: AuthRoutesOptions = {}
): (request: Request) => Promise<Response | undefined> {
  const {
    authBindingName = 'LUMENIZE_AUTH',
    authInstanceName = 'default',
    cors,
  } = options;

  const prefix = (env as any).LUMENIZE_AUTH_PREFIX || '/auth';

  // Normalize prefix (ensure starts with /, no trailing /)
  const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const cleanPrefix = normalizedPrefix.endsWith('/')
    ? normalizedPrefix.slice(0, -1)
    : normalizedPrefix;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if this is an auth route
    if (!path.startsWith(cleanPrefix + '/') && path !== cleanPrefix) {
      return undefined;
    }

    // Extract the endpoint path after the prefix
    const endpointPath = path.slice(cleanPrefix.length + 1) || '';

    // Rewrite URL to include binding and instance name
    const rewrittenPath = `${cleanPrefix}/${authBindingName}/${authInstanceName}/${endpointPath}`;
    const rewrittenUrl = new URL(request.url);
    rewrittenUrl.pathname = rewrittenPath;

    const rewrittenRequest = new Request(rewrittenUrl.toString(), request.clone() as RequestInit);

    const response = await routeDORequest(rewrittenRequest, env, {
      prefix: cleanPrefix,
      cors: cors as CorsOptions,
    });

    return response ?? undefined;
  };
}
