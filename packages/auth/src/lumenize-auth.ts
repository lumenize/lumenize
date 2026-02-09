import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { ALL_SCHEMAS } from './schemas';
import type { Subject, MagicLink, RefreshToken, LoginResponse, AuthError, EmailMessage } from './types';
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

/**
 * Error thrown by #authenticateRequest when authentication fails.
 * Caught by the top-level fetch() handler, which converts it to the appropriate Response.
 */
class AuthenticationError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

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
  #sql = sql(this);
  #schemaInitialized = false;

  /**
   * Ensure database schema is created
   */
  #ensureSchema(): void {
    if (this.#schemaInitialized) return;
    for (const schema of ALL_SCHEMAS) {
      this.ctx.storage.sql.exec(schema);
    }
    // Sweep expired tokens on every DO wake-up (tables are small, no extra indexes needed)
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokens WHERE expiresAt < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE expiresAt < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE expiresAt < ?', now);
    this.#schemaInitialized = true;
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
  get #inviteTtl(): number { return Number((this.env as any).LUMENIZE_AUTH_INVITE_TTL) || 604800; }
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
    const log = debug('auth.LumenizeAuth');

    try {
      if (path.endsWith('/email-magic-link') && request.method === 'POST') {
        return await this.#handleEmailMagicLink(request, url);
      }

      if (path.endsWith('/magic-link') && request.method === 'GET') {
        return await this.#handleMagicLink(request, url);
      }

      if (path.endsWith('/accept-invite') && request.method === 'GET') {
        return await this.#handleAcceptInvite(request, url);
      }

      if (path.endsWith('/refresh-token') && request.method === 'POST') {
        return await this.#handleRefreshToken(request);
      }

      if (path.endsWith('/logout') && request.method === 'POST') {
        return await this.#handleLogout(request);
      }

      if (path.endsWith('/delegated-token') && request.method === 'POST') {
        return await this.#handleDelegatedToken(request);
      }

      // Admin CRUD routes — parameterized paths matched via regex
      // Approve must come before subject to avoid /approve/:id matching /subject/:id
      const approveMatch = path.match(/\/approve\/([^/]+)$/);
      if (approveMatch && request.method === 'GET') {
        return await this.#handleApprove(request, approveMatch[1]);
      }

      // Actor management: /subject/:id/actors and /subject/:id/actors/:actorId
      const actorRemoveMatch = path.match(/\/subject\/([^/]+)\/actors\/([^/]+)$/);
      if (actorRemoveMatch && request.method === 'DELETE') {
        return await this.#handleRemoveActor(request, actorRemoveMatch[1], actorRemoveMatch[2]);
      }

      const actorAddMatch = path.match(/\/subject\/([^/]+)\/actors$/);
      if (actorAddMatch && request.method === 'POST') {
        return await this.#handleAddActor(request, actorAddMatch[1]);
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

      if (path.endsWith('/invite') && request.method === 'POST') {
        return await this.#handleInvite(request, url);
      }

      if (path.endsWith('/test/set-subject-data') && request.method === 'POST') {
        return await this.#handleTestSetSubjectData(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return this.#errorResponse(error.status, error.errorCode, error.message);
      }
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
      await this.#sendEmail({
        type: 'magic-link',
        to: email,
        magicLinkUrl,
      });
    } catch (error) {
      const log = debug('auth.LumenizeAuth');
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
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Invalid magic link token', { reason: 'not_found' });
      return this.#redirectWithError('invalid_token');
    }

    const magicLink = rows[0];

    // Check if already used
    if (magicLink.used) {
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Used magic link token', { reason: 'token_used', email: magicLink.email });
      return this.#redirectWithError('token_used');
    }

    // Check expiration
    if (Date.now() > magicLink.expiresAt) {
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Expired magic link token', { reason: 'token_expired', email: magicLink.email });
      return this.#redirectWithError('token_expired');
    }

    // Delete the token (single-use)
    this.#sql`DELETE FROM MagicLinks WHERE token = ${token}`;

    // Get or create subject, set emailVerified, apply bootstrap promotion
    const subject = this.#loginSubject(magicLink.email);

    const loginLog = debug('auth.LumenizeAuth.login.succeeded');
    loginLog.info('Magic link login', { targetSub: subject.sub, actorSub: 'system', email: magicLink.email });

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
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
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
      expires_in: this.#accessTokenTtl,
      sub: subject.sub,
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
      // Look up subjectId before revoking for audit log
      const tokenRows = this.#sql`
        SELECT subjectId FROM RefreshTokens WHERE tokenHash = ${tokenHash}
      ` as any[];
      this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE tokenHash = ${tokenHash}`;
      if (tokenRows.length > 0) {
        const auditLog = debug('auth.LumenizeAuth.token.revoked');
        auditLog.warn('Logout', { targetSub: tokenRows[0].subjectId, actorSub: tokenRows[0].subjectId, method: 'logout' });
      }
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
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'GET /subjects');

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const role = url.searchParams.get('role');

    let rows: any[];
    if (role === 'admin') {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
        FROM Subjects WHERE isAdmin = 1
        ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (role === 'none') {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
        FROM Subjects WHERE isAdmin = 0
        ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = this.#sql`
        SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
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
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'GET /subject/:id');

    const rows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    return Response.json({ subject: this.#rowToSubject(rows[0]) });
  }

  /**
   * PATCH {prefix}/subject/:id — Update a subject (admin only)
   * Updatable fields: isAdmin, adminApproved
   */
  async #handleUpdateSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'PATCH /subject/:id');

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

    // authorizedActors is managed via POST/DELETE /subject/:id/actors — reject if attempted via PATCH
    if (body.authorizedActors !== undefined) {
      return this.#errorResponse(400, 'invalid_request', 'Use POST /subject/:id/actors and DELETE /subject/:id/actors/:actorId to manage authorized actors');
    }

    // Apply updates
    const auditLog = debug('auth.LumenizeAuth.subject.updated');
    if (body.isAdmin !== undefined) {
      // isAdmin: true implicitly sets adminApproved: true
      if (body.isAdmin) {
        this.#sql`UPDATE Subjects SET isAdmin = 1, adminApproved = 1 WHERE sub = ${subjectId}`;
      } else {
        this.#sql`UPDATE Subjects SET isAdmin = 0 WHERE sub = ${subjectId}`;
      }
      auditLog.info('Subject isAdmin updated', { targetSub: subjectId, actorSub: auth.sub, field: 'isAdmin', from: Boolean(targetRows[0].isAdmin), to: body.isAdmin });
    }

    if (body.adminApproved !== undefined) {
      this.#sql`UPDATE Subjects SET adminApproved = ${body.adminApproved ? 1 : 0} WHERE sub = ${subjectId}`;
      auditLog.info('Subject adminApproved updated', { targetSub: subjectId, actorSub: auth.sub, field: 'adminApproved', from: Boolean(targetRows[0].adminApproved), to: body.adminApproved });
      // Revoking approval invalidates existing sessions
      if (!body.adminApproved) {
        this.#revokeAllTokensForSubject(subjectId);
        const revokeLog = debug('auth.LumenizeAuth.token.revoked');
        revokeLog.warn('Tokens revoked on approval revocation', { targetSub: subjectId, actorSub: auth.sub, method: 'approval_revoked' });
      }
    }

    // Re-read and return the updated subject
    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  /**
   * DELETE {prefix}/subject/:id — Delete a subject (admin only)
   */
  async #handleDeleteSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'DELETE /subject/:id');

    // Self-deletion prevention
    if (auth.sub === subjectId) {
      return this.#errorResponse(403, 'forbidden', 'Cannot delete yourself');
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

    // Delete subject — RefreshTokens and AuthorizedActors cleaned up via ON DELETE CASCADE
    this.#sql`DELETE FROM Subjects WHERE sub = ${subjectId}`;

    // Clean up MagicLinks and InviteTokens by email (no FK, manual cleanup)
    this.#sql`DELETE FROM MagicLinks WHERE email = ${targetEmail}`;
    this.#sql`DELETE FROM InviteTokens WHERE email = ${targetEmail}`;

    const auditLog = debug('auth.LumenizeAuth.subject.deleted');
    auditLog.warn('Subject deleted', { targetSub: subjectId, actorSub: auth.sub, email: targetEmail });

    return new Response(null, { status: 204 });
  }

  /**
   * POST {prefix}/subject/:id/actors — Add an authorized actor (admin only)
   * Body: { actorSub: string }
   */
  async #handleAddActor(request: Request, principalSub: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'POST /subject/:id/actors');

    let body: { actorSub?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    const actorSub = body.actorSub;
    if (!actorSub) {
      return this.#errorResponse(400, 'invalid_request', 'actorSub required');
    }

    // Verify principal exists
    const principalRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${principalSub}` as any[];
    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    // Verify actor exists
    const actorRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${actorSub}` as any[];
    if (actorRows.length === 0) {
      return this.#errorResponse(400, 'invalid_request', `Actor ID not found: ${actorSub}`);
    }

    // Insert (idempotent — INSERT OR IGNORE for composite PK)
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO AuthorizedActors (principalSub, actorSub) VALUES (?, ?)',
      principalSub, actorSub
    );

    const auditLogAdd = debug('auth.LumenizeAuth.actor.added');
    auditLogAdd.info('Authorized actor added', { targetSub: principalSub, actorSub, adminSub: auth.sub });

    // Return the updated subject
    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${principalSub}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  /**
   * DELETE {prefix}/subject/:id/actors/:actorId — Remove an authorized actor (admin only)
   */
  async #handleRemoveActor(request: Request, principalSub: string, actorSub: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'DELETE /subject/:id/actors/:actorId');

    // Verify principal exists
    const principalRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${principalSub}` as any[];
    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    // Delete the relationship (idempotent)
    this.#sql`DELETE FROM AuthorizedActors WHERE principalSub = ${principalSub} AND actorSub = ${actorSub}`;

    const auditLogRemove = debug('auth.LumenizeAuth.actor.removed');
    auditLogRemove.info('Authorized actor removed', { targetSub: principalSub, actorSub, adminSub: auth.sub });

    // Return the updated subject
    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${principalSub}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  /**
   * GET {prefix}/approve/:id — Approve a subject (admin only, browser-friendly)
   * Redirects to LUMENIZE_AUTH_REDIRECT on success.
   */
  async #handleApprove(request: Request, subjectId: string): Promise<Response> {
    let auth: { sub: string; isAdmin: boolean; email: string };
    try {
      auth = await this.#authenticateRequest(request);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        // Not authenticated — redirect with error so browser doesn't show raw JSON
        const separator = this.#redirect.includes('?') ? '&' : '?';
        return new Response(null, {
          status: 302,
          headers: { 'Location': `${this.#redirect}${separator}error=login_required` }
        });
      }
      throw error;
    }

    if (!auth.isAdmin) {
      return this.#accessDenied(auth.sub, 'GET /approve/:id');
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

    const auditLog = debug('auth.LumenizeAuth.subject.updated');
    auditLog.info('Subject approved', { targetSub: subjectId, actorSub: auth.sub, field: 'adminApproved', from: Boolean(rows[0].adminApproved), to: true });

    // Send approval confirmation email to the subject
    try {
      await this.#sendEmail({
        type: 'approval-confirmation',
        to: rows[0].email,
        redirectUrl: this.#redirect,
      });
    } catch (error) {
      const log = debug('auth.LumenizeAuth');
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
  // Invite & Delegation Endpoints
  // ============================================

  /**
   * POST {prefix}/invite — Bulk invite emails (admin only)
   *
   * Creates subjects with adminApproved=true and sends invite emails.
   * Test mode: returns invite links instead of sending emails.
   */
  async #handleInvite(request: Request, url: URL): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'POST /invite');

    let body: { emails?: string[] };
    try {
      body = await request.json() as typeof body;
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    const emails = body.emails;
    if (!Array.isArray(emails)) {
      return this.#errorResponse(400, 'invalid_request', 'emails array required');
    }

    const isTestMode = this.#isTestMode && url.searchParams.get('_test') === 'true';
    const invited: string[] = [];
    const errors: Array<{ email: string; error: string }> = [];
    const links: Record<string, string> = {};

    for (const rawEmail of emails) {
      const email = rawEmail?.toLowerCase().trim();
      if (!email || !this.#isValidEmail(email)) {
        errors.push({ email: rawEmail, error: 'Invalid email format' });
        continue;
      }

      try {
        // Look up existing subject
        const existingRows = this.#sql`
          SELECT sub, email, emailVerified, adminApproved FROM Subjects WHERE email = ${email}
        ` as any[];

        if (existingRows.length > 0) {
          const existing = existingRows[0];
          // Ensure adminApproved regardless
          this.#sql`UPDATE Subjects SET adminApproved = 1 WHERE sub = ${existing.sub}`;

          if (existing.emailVerified) {
            // Already verified — send invite-existing email (notification), no token needed
            if (isTestMode) {
              // No invite link for already-verified subjects
              links[email] = '(already verified)';
            } else {
              try {
                await this.#sendEmail({
                  type: 'invite-existing',
                  to: email,
                  redirectUrl: this.#redirect,
                });
              } catch (error) {
                const log = debug('auth.LumenizeAuth');
                log.error('Failed to send invite email', { error: error instanceof Error ? error.message : String(error), email });
              }
            }
            const inviteLog = debug('auth.LumenizeAuth.invite.sent');
            inviteLog.info('Invite sent', { targetSub: existing.sub, actorSub: auth.sub, email });
            invited.push(email);
            continue;
          }

          // Exists but not verified — generate invite token and send
        } else {
          // Create new subject with adminApproved=true, emailVerified=false
          const sub = generateUuid();
          const now = Date.now();
          this.#sql`
            INSERT INTO Subjects (sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt)
            VALUES (${sub}, ${email}, 0, 1, 0, ${now}, ${null})
          `;
          const createdLog = debug('auth.LumenizeAuth.subject.created');
          createdLog.info('Subject created via invite', { targetSub: sub, actorSub: auth.sub, email });
        }

        // Generate invite token (for new subjects and existing-not-verified)
        const token = generateRandomString(32);
        const expiresAt = Date.now() + (this.#inviteTtl * 1000);
        this.#sql`
          INSERT INTO InviteTokens (token, email, expiresAt)
          VALUES (${token}, ${email}, ${expiresAt})
        `;

        const inviteUrl = `${url.origin}${this.#prefix}/accept-invite?invite_token=${token}`;

        if (isTestMode) {
          links[email] = inviteUrl;
        } else {
          try {
            await this.#sendEmail({
              type: 'invite-new',
              to: email,
              inviteUrl,
            });
          } catch (error) {
            const log = debug('auth.LumenizeAuth');
            log.error('Failed to send invite email', { error: error instanceof Error ? error.message : String(error), email });
          }
        }

        const inviteLog = debug('auth.LumenizeAuth.invite.sent');
        inviteLog.info('Invite sent', { actorSub: auth.sub, email });
        invited.push(email);
      } catch (error) {
        errors.push({ email, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    const responseBody: any = { invited, errors };
    if (isTestMode) responseBody.links = links;
    return Response.json(responseBody);
  }

  /**
   * GET {prefix}/accept-invite?invite_token=... — Accept invite and complete login
   *
   * Validates reusable invite token, sets emailVerified=true, issues refresh token, redirects.
   */
  async #handleAcceptInvite(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('invite_token');

    if (!token) {
      return this.#errorResponse(400, 'invalid_request', 'Missing invite_token');
    }

    // Look up invite token (reusable — do NOT delete)
    const rows = this.#sql`
      SELECT token, email, expiresAt FROM InviteTokens WHERE token = ${token}
    ` as any[];

    if (rows.length === 0) {
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Invalid invite token', { reason: 'not_found' });
      return this.#redirectWithError('invalid_token');
    }

    const inviteToken = rows[0];

    if (Date.now() > inviteToken.expiresAt) {
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Expired invite token', { reason: 'token_expired', email: inviteToken.email });
      return this.#redirectWithError('token_expired');
    }

    // Look up subject by email
    const subjectRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE email = ${inviteToken.email}
    ` as any[];

    if (subjectRows.length === 0) {
      const auditLog = debug('auth.LumenizeAuth.login.failed');
      auditLog.warn('Invite token for missing subject', { reason: 'subject_not_found', email: inviteToken.email });
      return this.#redirectWithError('invalid_token');
    }

    const sub = subjectRows[0].sub;
    const now = Date.now();

    // Set emailVerified and update lastLoginAt
    this.#sql`UPDATE Subjects SET emailVerified = 1, lastLoginAt = ${now} WHERE sub = ${sub}`;

    const loginLog = debug('auth.LumenizeAuth.login.succeeded');
    loginLog.info('Invite accepted', { targetSub: sub, actorSub: 'system', email: inviteToken.email });

    if (!subjectRows[0].emailVerified) {
      const updateLog = debug('auth.LumenizeAuth.subject.updated');
      updateLog.info('Email verified via invite', { targetSub: sub, actorSub: 'system', field: 'emailVerified', from: false, to: true });
    }

    // Generate refresh token
    const refreshToken = await this.#generateRefreshToken(sub);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': this.#redirect,
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken)
      }
    });
  }

  /**
   * POST {prefix}/delegated-token — Request token to act on behalf of another subject
   *
   * Actor authenticates with their own token. Returns access token with
   * sub=principal, act.sub=actor. Admins bypass AuthorizedActors check.
   */
  async #handleDelegatedToken(request: Request): Promise<Response> {
    const auth = await this.#authenticateRequest(request);

    let body: { actFor?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return this.#errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    const actFor = body.actFor;
    if (!actFor) {
      return this.#errorResponse(400, 'invalid_request', 'actFor required');
    }

    // Look up principal
    const principalRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${actFor}
    ` as any[];

    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    const principal = this.#rowToSubject(principalRows[0]);

    // Authorization: admin bypasses, non-admin must be in AuthorizedActors table
    if (!auth.isAdmin) {
      const actorRows = this.#sql`
        SELECT 1 FROM AuthorizedActors WHERE principalSub = ${actFor} AND actorSub = ${auth.sub}
      ` as any[];
      if (actorRows.length === 0) {
        const auditLog = debug('auth.LumenizeAuth.access.denied');
        auditLog.warn('Unauthorized delegation attempt', { sub: auth.sub, endpoint: 'POST /delegated-token', targetSub: actFor });
        return this.#errorResponse(403, 'forbidden', 'Not authorized to act for this subject');
      }
    }

    // Generate delegated access token: sub=principal, act.sub=actor
    const accessToken = await this.#generateAccessToken(principal, auth.sub);

    const auditLog = debug('auth.LumenizeAuth.token.delegated');
    auditLog.info('Delegated token issued', { targetSub: actFor, actorSub: auth.sub, principalSub: actFor });

    return Response.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.#accessTokenTtl
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

    return new Response(null, { status: 204 });
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
    { sub: string; isAdmin: boolean; email: string }
  > {
    // Strategy 1: Bearer JWT
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        const token = parts[1];
        const identity = await this.#verifyBearerToken(token);
        if (identity) return identity;
        const auditLog = debug('auth.LumenizeAuth.access.denied');
        auditLog.warn('Invalid or expired access token', { reason: 'invalid_token' });
        throw new AuthenticationError(401, 'invalid_token', 'Invalid or expired access token');
      }
    }

    // Strategy 2: refresh-token cookie
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');
    if (refreshToken) {
      const identity = await this.#verifyRefreshTokenIdentity(refreshToken);
      if (identity) return identity;
    }

    const auditLog = debug('auth.LumenizeAuth.access.denied');
    auditLog.warn('Authentication required', { reason: 'no_valid_credential' });
    throw new AuthenticationError(401, 'invalid_token', 'Authentication required');
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
   * Send an email via the AUTH_EMAIL_SENDER service binding.
   * When the binding is not configured, logs the email at debug level
   * so developers see feedback during local development.
   */
  async #sendEmail(message: EmailMessage): Promise<void> {
    const sender = (this.env as any).AUTH_EMAIL_SENDER;
    if (sender) {
      await sender.send(message);
    } else {
      const log = debug('auth.LumenizeAuth');
      log.debug(`Email not sent (AUTH_EMAIL_SENDER not configured)`, { type: message.type, to: message.to });
    }
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
        await this.#sendEmail({
          type: 'admin-notification',
          to: admin.email,
          subjectEmail: subject.email,
          approveUrl,
        });
      } catch (error) {
        const log = debug('auth.LumenizeAuth');
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
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
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
        INSERT INTO Subjects (sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt)
        VALUES (${sub}, ${normalizedEmail}, 0, 0, 0, ${now}, ${now})
      `;
      const auditLog = debug('auth.LumenizeAuth.subject.created');
      auditLog.info('Subject created via magic link', { targetSub: sub, actorSub: 'system', email: normalizedEmail });
    }

    // Set emailVerified + lastLoginAt (always on magic link login)
    // Bootstrap: idempotently promote to admin with all three flags
    if (isBootstrap) {
      // Only log bootstrap promotion when flags actually change
      if (existingRows.length === 0 || !existingRows[0].isAdmin) {
        const auditLog = debug('auth.LumenizeAuth.subject.updated');
        auditLog.info('Bootstrap promotion', { targetSub: sub, actorSub: 'system', field: 'isAdmin', from: false, to: true });
      }
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
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${sub}
    ` as any[];

    return this.#rowToSubject(freshRows[0]);
  }

  /**
   * Convert a SQL row to a Subject object.
   * Queries the AuthorizedActors junction table for the delegation list.
   */
  #rowToSubject(row: any): Subject {
    const actorRows = this.#sql`
      SELECT actorSub FROM AuthorizedActors WHERE principalSub = ${row.sub}
    ` as any[];
    return {
      ...row,
      emailVerified: Boolean(row.emailVerified),
      adminApproved: Boolean(row.adminApproved),
      isAdmin: Boolean(row.isAdmin),
      authorizedActors: actorRows.map((r: any) => r.actorSub),
    };
  }

  /**
   * Generate a signed JWT access token with subject claims
   */
  async #generateAccessToken(subject: Subject, actorSub?: string): Promise<string> {
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
      act: actorSub ? { sub: actorSub } : undefined,
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
   * Log access.denied and return a 403 response.
   */
  #accessDenied(sub: string, endpoint: string): Response {
    const auditLog = debug('auth.LumenizeAuth.access.denied');
    auditLog.warn('Non-admin access denied', { sub, endpoint });
    return this.#errorResponse(403, 'forbidden', 'Admin access required');
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
