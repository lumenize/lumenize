import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { ALL_SCHEMAS } from './schemas';
import type { Subject, MagicLink, RefreshToken, LoginResponse, AuthError, EmailService } from './types';
import {
  generateRandomString,
  generateUuid,
  hashString,
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  createJwtPayload,
  parseJwtUnsafe
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
    // Sweep expired tokens on every DO wake-up (indexed on expiresAt, fast even with zero matches)
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokens WHERE expiresAt < ?', Date.now());
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
  get #bootstrapEmail(): string | undefined { return (this.env as any).LUMENIZE_AUTH_BOOTSTRAP_EMAIL?.toLowerCase(); }
  get #isTestMode(): boolean { return (this.env as any).LUMENIZE_AUTH_TEST_MODE === 'true'; }

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

      // Admin CRUD routes — parameterized paths matched via regex
      // Approve must come before subject to avoid /approve/:id matching /subject/:id
      const approveMatch = path.match(/\/approve\/([^/]+)$/);
      if (approveMatch && request.method === 'GET') {
        return await this.#handleApprove(request, approveMatch[1]);
      }

      const subjectMatch = path.match(/\/subject\/([^/]+)$/);
      if (subjectMatch) {
        if (request.method === 'GET') return await this.#handleGetSubject(request, subjectMatch[1]);
        if (request.method === 'PATCH') return await this.#handleUpdateSubject(request, subjectMatch[1]);
        if (request.method === 'DELETE') return await this.#handleDeleteSubject(request, subjectMatch[1]);
      }

      if (path.endsWith('/subjects') && request.method === 'GET') {
        return await this.#handleListSubjects(request, url);
      }

      if (path.endsWith('/test/set-subject-data') && request.method === 'POST') {
        return await this.#handleTestSetSubjectData(request);
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
      INSERT INTO MagicLinks (token, email, expiresAt, used)
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
      await this.#emailService.send({
        type: 'magic-link',
        to: email,
        subject: 'Your login link',
        magicLinkUrl,
      });
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
      SELECT token, email, expiresAt, used
      FROM MagicLinks
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
    if (Date.now() > magicLink.expiresAt) {
      return this.#redirectWithError('token_expired');
    }

    // Delete the token (single-use)
    this.#sql`DELETE FROM MagicLinks WHERE token = ${token}`;

    // Get or create subject, set emailVerified, apply bootstrap promotion
    const subject = this.#loginSubject(magicLink.email);

    // Notify admins about non-approved signups (fire-and-forget, errors don't block login)
    if (!subject.adminApproved && !subject.isAdmin) {
      await this.#notifyAdminsOfSignup(subject, url);
    }

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
      SELECT tokenHash, subjectId, expiresAt, revoked
      FROM RefreshTokens
      WHERE tokenHash = ${tokenHash}
    ` as RefreshToken[];

    if (rows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Invalid refresh token');
    }

    const storedToken = rows[0];

    if (storedToken.revoked) {
      return this.#errorResponse(401, 'token_revoked', 'Refresh token has been revoked');
    }

    if (Date.now() > storedToken.expiresAt) {
      return this.#errorResponse(401, 'token_expired', 'Refresh token expired');
    }

    // Revoke old refresh token (rotation)
    this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE tokenHash = ${tokenHash}`;

    // Look up the subject to get current flags for JWT claims
    const subjectRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${storedToken.subjectId}
    ` as any[];

    if (subjectRows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Subject not found');
    }

    const subject = this.#rowToSubject(subjectRows[0]);

    // Generate new tokens
    const newAccessToken = await this.#generateAccessToken(subject);
    const newRefreshToken = await this.#generateRefreshToken(storedToken.subjectId);

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
      this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE tokenHash = ${tokenHash}`;
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
  // Admin Subject Management
  // ============================================

  /**
   * GET {prefix}/subjects — List all subjects (admin only)
   * Query params: limit (default 50), offset (default 0), role (admin|none)
   */
  async #handleListSubjects(request: Request, url: URL): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (auth instanceof Response) return auth;
    if (!auth.isAdmin) return this.#errorResponse(403, 'forbidden', 'Admin access required');

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const role = url.searchParams.get('role');

    let rows: any[];
    if (role === 'admin') {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
        FROM Subjects WHERE isAdmin = 1
        ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (role === 'none') {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
        FROM Subjects WHERE isAdmin = 0
        ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
        FROM Subjects
        ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return Response.json({ subjects: rows.map(r => this.#rowToSubject(r)) });
  }

  /**
   * GET {prefix}/subject/:id — Get a single subject (admin only)
   */
  async #handleGetSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (auth instanceof Response) return auth;
    if (!auth.isAdmin) return this.#errorResponse(403, 'forbidden', 'Admin access required');

    const rows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    return Response.json({ subject: this.#rowToSubject(rows[0]) });
  }

  /**
   * PATCH {prefix}/subject/:id — Update a subject (admin only)
   * Updatable fields: isAdmin, adminApproved, authorizedActors
   */
  async #handleUpdateSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (auth instanceof Response) return auth;
    if (!auth.isAdmin) return this.#errorResponse(403, 'forbidden', 'Admin access required');

    // Self-modification prevention
    if (auth.sub === subjectId) {
      return this.#errorResponse(403, 'forbidden', 'Cannot modify own admin status');
    }

    // Bootstrap protection
    const targetRows = this.#sql`
      SELECT sub, email, isAdmin FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (targetRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    if (targetRows[0].email === this.#bootstrapEmail) {
      return this.#errorResponse(403, 'forbidden', 'Cannot modify bootstrap admin');
    }

    let body: { isAdmin?: boolean; adminApproved?: boolean; authorizedActors?: string[] };
    try {
      body = await request.json() as typeof body;
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    // Apply updates
    if (body.isAdmin !== undefined) {
      // isAdmin: true implicitly sets adminApproved: true
      if (body.isAdmin) {
        this.#sql`UPDATE Subjects SET isAdmin = 1, adminApproved = 1 WHERE sub = ${subjectId}`;
      } else {
        this.#sql`UPDATE Subjects SET isAdmin = 0 WHERE sub = ${subjectId}`;
      }
    }

    if (body.adminApproved !== undefined) {
      this.#sql`UPDATE Subjects SET adminApproved = ${body.adminApproved ? 1 : 0} WHERE sub = ${subjectId}`;
      // Revoking approval invalidates existing sessions
      if (!body.adminApproved) {
        this.#revokeAllTokensForSubject(subjectId);
      }
    }

    if (body.authorizedActors !== undefined) {
      this.#sql`UPDATE Subjects SET authorizedActors = ${JSON.stringify(body.authorizedActors)} WHERE sub = ${subjectId}`;
    }

    // Re-read and return the updated subject
    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  /**
   * DELETE {prefix}/subject/:id — Delete a subject (admin only)
   */
  async #handleDeleteSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (auth instanceof Response) return auth;
    if (!auth.isAdmin) return this.#errorResponse(403, 'forbidden', 'Admin access required');

    // Self-deletion prevention
    if (auth.sub === subjectId) {
      return this.#errorResponse(403, 'forbidden', 'Cannot modify own admin status');
    }

    // Bootstrap protection
    const targetRows = this.#sql`
      SELECT sub, email FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (targetRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    if (targetRows[0].email === this.#bootstrapEmail) {
      return this.#errorResponse(403, 'forbidden', 'Cannot modify bootstrap admin');
    }

    const targetEmail = targetRows[0].email;

    // Revoke all tokens before deletion
    this.#revokeAllTokensForSubject(subjectId);

    // Delete subject — RefreshTokens cleaned up via ON DELETE CASCADE
    this.#sql`DELETE FROM Subjects WHERE sub = ${subjectId}`;

    // Clean up MagicLinks and InviteTokens by email (no FK, manual cleanup)
    this.#sql`DELETE FROM MagicLinks WHERE email = ${targetEmail}`;
    this.#sql`DELETE FROM InviteTokens WHERE email = ${targetEmail}`;

    return Response.json({ ok: true });
  }

  /**
   * GET {prefix}/approve/:id — Approve a subject (admin only, browser-friendly)
   * Redirects to LUMENIZE_AUTH_REDIRECT on success.
   */
  async #handleApprove(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (auth instanceof Response) {
      // Not authenticated — redirect with error so browser doesn't show raw JSON
      const separator = this.#redirect.includes('?') ? '&' : '?';
      return new Response(null, {
        status: 302,
        headers: { 'Location': `${this.#redirect}${separator}error=login_required` }
      });
    }

    if (!auth.isAdmin) {
      return this.#errorResponse(403, 'forbidden', 'Admin access required');
    }

    // Look up subject
    const rows = this.#sql`
      SELECT sub, email, adminApproved FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    // Set adminApproved (idempotent)
    this.#sql`UPDATE Subjects SET adminApproved = 1 WHERE sub = ${subjectId}`;

    // Send approval confirmation email to the subject
    try {
      await this.#emailService.send({
        type: 'approval-confirmation',
        to: rows[0].email,
        subject: 'Your account has been approved',
        redirectUrl: this.#redirect,
      });
    } catch (error) {
      const log = this.#debug('auth.LumenizeAuth');
      log.error('Failed to send approval confirmation email', {
        error: error instanceof Error ? error.message : String(error),
        email: rows[0].email
      });
    }

    // Redirect admin back to app
    return new Response(null, {
      status: 302,
      headers: { 'Location': this.#redirect }
    });
  }

  // ============================================
  // Test-Only Endpoints
  // ============================================

  /**
   * POST {prefix}/test/set-subject-data — Set subject flags (test mode only)
   *
   * Used by testLoginWithMagicLink to set adminApproved/isAdmin flags
   * after login, before the refresh-token exchange mints the JWT.
   * Guarded by LUMENIZE_AUTH_TEST_MODE.
   */
  async #handleTestSetSubjectData(request: Request): Promise<Response> {
    if (!this.#isTestMode) {
      return this.#errorResponse(403, 'forbidden', 'Test mode not enabled');
    }

    let body: { email?: string; adminApproved?: boolean; isAdmin?: boolean };
    try {
      body = await request.json() as typeof body;
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    const email = body.email?.toLowerCase().trim();
    if (!email) {
      return this.#errorResponse(400, 'invalid_request', 'Email required');
    }

    // Look up subject by email
    const rows = this.#sql`
      SELECT sub FROM Subjects WHERE email = ${email}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    const sub = rows[0].sub;

    // Build SET clause for provided fields
    if (body.adminApproved !== undefined) {
      this.#sql`UPDATE Subjects SET adminApproved = ${body.adminApproved ? 1 : 0} WHERE sub = ${sub}`;
    }
    if (body.isAdmin !== undefined) {
      // isAdmin implicitly satisfies adminApproved
      this.#sql`UPDATE Subjects SET isAdmin = ${body.isAdmin ? 1 : 0}, adminApproved = 1 WHERE sub = ${sub}`;
    }

    return Response.json({ ok: true, sub });
  }

  // ============================================
  // Authentication
  // ============================================

  /**
   * Authenticate an incoming request via Bearer JWT or refresh-token cookie.
   * Returns the authenticated identity or a 401 Response.
   *
   * 1. Authorization: Bearer <jwt> — verify signature + expiration with public keys
   * 2. Fallback: refresh-token cookie — hash, look up in RefreshTokens, load subject
   *
   * Does NOT perform access-gate checks (emailVerified/adminApproved) — callers
   * decide what level of authorization they need.
   */
  async #authenticateRequest(request: Request): Promise<
    { sub: string; isAdmin: boolean; email: string } | Response
  > {
    // Strategy 1: Bearer JWT
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        const token = parts[1];
        const identity = await this.#verifyBearerToken(token);
        if (identity) return identity;
        return this.#errorResponse(401, 'invalid_token', 'Invalid or expired access token');
      }
    }

    // Strategy 2: refresh-token cookie
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');
    if (refreshToken) {
      const identity = await this.#verifyRefreshTokenIdentity(refreshToken);
      if (identity) return identity;
    }

    return this.#errorResponse(401, 'invalid_token', 'Authentication required');
  }

  /**
   * Verify a Bearer JWT and return identity if valid.
   * Uses BLUE/GREEN key rotation.
   */
  async #verifyBearerToken(token: string): Promise<
    { sub: string; isAdmin: boolean; email: string } | null
  > {
    const envAny = this.env as any;
    const publicKeysPem = [envAny.JWT_PUBLIC_KEY_BLUE, envAny.JWT_PUBLIC_KEY_GREEN].filter(Boolean);
    if (publicKeysPem.length === 0) return null;

    const publicKeys = await Promise.all(publicKeysPem.map((pem: string) => importPublicKey(pem)));

    const payload = publicKeys.length === 1
      ? await verifyJwt(token, publicKeys[0])
      : await verifyJwtWithRotation(token, publicKeys);

    if (!payload || !payload.sub) return null;

    // Look up the subject to get current email (JWT doesn't carry email)
    const rows = this.#sql`
      SELECT email, isAdmin FROM Subjects WHERE sub = ${payload.sub}
    ` as any[];

    if (rows.length === 0) return null;

    return {
      sub: payload.sub,
      isAdmin: Boolean(rows[0].isAdmin),
      email: rows[0].email,
    };
  }

  /**
   * Verify a refresh token cookie and return identity if valid.
   * Does NOT rotate the token — that's only done in #handleRefreshToken.
   */
  async #verifyRefreshTokenIdentity(refreshToken: string): Promise<
    { sub: string; isAdmin: boolean; email: string } | null
  > {
    const tokenHash = await hashString(refreshToken);

    const rows = this.#sql`
      SELECT subjectId, expiresAt, revoked
      FROM RefreshTokens
      WHERE tokenHash = ${tokenHash}
    ` as any[];

    if (rows.length === 0) return null;
    if (rows[0].revoked) return null;
    if (Date.now() > rows[0].expiresAt) return null;

    // Look up the subject
    const subjectRows = this.#sql`
      SELECT sub, email, isAdmin FROM Subjects WHERE sub = ${rows[0].subjectId}
    ` as any[];

    if (subjectRows.length === 0) return null;

    return {
      sub: subjectRows[0].sub,
      isAdmin: Boolean(subjectRows[0].isAdmin),
      email: subjectRows[0].email,
    };
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Revoke all refresh tokens for a subject.
   * Called when adminApproved is revoked or subject is deleted.
   */
  #revokeAllTokensForSubject(subjectId: string): void {
    this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE subjectId = ${subjectId}`;
  }

  /**
   * Notify all admins that a new user has signed up and needs approval.
   * Each email send is individually try/caught — failure for one admin doesn't block others.
   */
  async #notifyAdminsOfSignup(subject: Subject, url: URL): Promise<void> {
    const adminRows = this.#sql`SELECT email FROM Subjects WHERE isAdmin = 1` as any[];
    if (adminRows.length === 0) return;

    const approveUrl = `${url.origin}${this.#prefix}/approve/${subject.sub}`;

    for (const admin of adminRows) {
      try {
        await this.#emailService.send({
          type: 'admin-notification',
          to: admin.email,
          subject: `New signup: ${subject.email}`,
          subjectEmail: subject.email,
          approveUrl,
        });
      } catch (error) {
        const log = this.#debug('auth.LumenizeAuth');
        log.error('Failed to send admin notification', {
          error: error instanceof Error ? error.message : String(error),
          adminEmail: admin.email,
          subjectEmail: subject.email
        });
      }
    }
  }

  /**
   * Get or create a subject by email, set emailVerified, and apply bootstrap promotion.
   * Called during magic link validation — returns the subject with current DB state.
   */
  #loginSubject(email: string): Subject {
    const normalizedEmail = email.toLowerCase();
    const now = Date.now();
    const isBootstrap = this.#bootstrapEmail === normalizedEmail;

    const existingRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
      FROM Subjects
      WHERE email = ${normalizedEmail}
    ` as any[];

    let sub: string;

    if (existingRows.length > 0) {
      sub = existingRows[0].sub;
    } else {
      // Create new subject
      sub = generateUuid();
      this.#sql`
        INSERT INTO Subjects (sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt)
        VALUES (${sub}, ${normalizedEmail}, 0, 0, 0, '[]', ${now}, ${now})
      `;
    }

    // Set emailVerified + lastLoginAt (always on magic link login)
    // Bootstrap: idempotently promote to admin with all three flags
    if (isBootstrap) {
      this.#sql`
        UPDATE Subjects
        SET emailVerified = 1, adminApproved = 1, isAdmin = 1, lastLoginAt = ${now}
        WHERE sub = ${sub}
      `;
    } else {
      this.#sql`
        UPDATE Subjects
        SET emailVerified = 1, lastLoginAt = ${now}
        WHERE sub = ${sub}
      `;
    }

    // Re-read to return fresh state
    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, authorizedActors, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${sub}
    ` as any[];

    return this.#rowToSubject(freshRows[0]);
  }

  /**
   * Convert a SQL row to a Subject object
   */
  #rowToSubject(row: any): Subject {
    return {
      ...row,
      emailVerified: Boolean(row.emailVerified),
      adminApproved: Boolean(row.adminApproved),
      isAdmin: Boolean(row.isAdmin),
      authorizedActors: JSON.parse(row.authorizedActors || '[]'),
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
      INSERT INTO RefreshTokens (tokenHash, subjectId, expiresAt, createdAt, revoked)
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
