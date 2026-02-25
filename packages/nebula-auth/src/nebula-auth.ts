/**
 * NebulaAuth — Per-instance Durable Object for multi-tenant authentication
 *
 * Forked from @lumenize/auth LumenizeAuth. Key differences:
 * - Path-scoped cookies: Path={prefix}/{instanceName}
 * - JWT access claim: { id, admin? } instead of flat isAdmin/emailVerified
 * - buildAccessId() for tier-aware wildcard patterns
 * - First-user-is-founder: zero subjects → first verified email becomes admin
 * - Platform admin: nebula-platform instance + bootstrap email → { id: "*", admin: true }
 * - Constants are hardcoded, not env vars (except secrets)
 *
 * @see tasks/nebula-auth.md § Phase 2
 */
import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { ALL_SCHEMAS } from './schemas';
import type { Subject, MagicLink, RefreshToken, NebulaJwtPayload, AccessEntry } from './types';
import {
  NEBULA_AUTH_PREFIX,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  MAGIC_LINK_TTL,
  INVITE_TTL,
  NEBULA_AUTH_ISSUER,
  NEBULA_AUTH_AUDIENCE,
} from './types';
import { buildAccessId, isPlatformInstance } from './parse-id';
import {
  generateRandomString,
  generateUuid,
  hashString,
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  parseJwtUnsafe,
} from '@lumenize/auth';

/**
 * Error thrown by #authenticateRequest when authentication fails.
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

interface AuthError {
  error: string;
  error_description: string;
}

/**
 * SQL template literal tag for Durable Object storage.
 */
function sql(doInstance: any) {
  const ctx = doInstance.ctx;
  return (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) =>
      acc + str + (i < values.length ? '?' : ''), '');
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

export class NebulaAuth extends DurableObject {
  #sql = sql(this);
  #schemaInitialized = false;

  /**
   * The instance name (universeGalaxyStarId) is derived from the DO name.
   * Set on first fetch from the URL path.
   */
  #instanceName: string | null = null;

  #ensureSchema(): void {
    if (this.#schemaInitialized) return;
    for (const schema of ALL_SCHEMAS) {
      this.ctx.storage.sql.exec(schema);
    }
    // Sweep expired tokens on every DO wake-up
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokens WHERE expiresAt < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE expiresAt < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE expiresAt < ?', now);
    this.#schemaInitialized = true;
  }

  // ============================================
  // Config helpers — hardcoded constants + env secrets
  // ============================================

  get #redirect(): string { return (this.env as any).NEBULA_AUTH_REDIRECT; }
  get #prefix(): string { return NEBULA_AUTH_PREFIX; }
  get #bootstrapEmail(): string | undefined { return (this.env as any).NEBULA_AUTH_BOOTSTRAP_EMAIL?.toLowerCase(); }
  get #isTestMode(): boolean { return (this.env as any).NEBULA_AUTH_TEST_MODE === 'true'; }

  /**
   * Get a stub for the singleton NebulaAuthRegistry DO.
   */
  get #registry() {
    return (this.env as any).NEBULA_AUTH_REGISTRY.getByName('registry');
  }

  /**
   * Extract the instanceName from the URL path.
   * URL format: {prefix}/{instanceName}/endpoint
   * The instanceName is the segment after the prefix and before the endpoint.
   */
  #extractInstanceName(path: string): string | null {
    const prefix = this.#prefix;
    if (!path.startsWith(prefix + '/')) return null;
    const rest = path.slice(prefix.length + 1); // after "{prefix}/"
    // rest is like "acme.crm.tenant/refresh-token" or "nebula-platform/magic-link"
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return rest || null; // bare instance name
    return rest.slice(0, slashIdx) || null;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#redirect) {
      return this.#errorResponse(500, 'server_error', 'NEBULA_AUTH_REDIRECT not set');
    }

    this.#ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;
    const log = debug('nebula-auth.NebulaAuth');

    // Extract instance name from first request
    if (!this.#instanceName) {
      this.#instanceName = this.#extractInstanceName(path);
    }

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

      // Admin CRUD routes
      const approveMatch = path.match(/\/approve\/([^/]+)$/);
      if (approveMatch && request.method === 'GET') {
        return await this.#handleApprove(request, approveMatch[1]);
      }

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

    const token = generateRandomString(32);
    const expiresAt = Date.now() + (MAGIC_LINK_TTL * 1000);

    this.#sql`
      INSERT INTO MagicLinks (token, email, expiresAt, used)
      VALUES (${token}, ${email}, ${expiresAt}, 0)
    `;

    const baseUrl = url.origin;
    const instanceName = this.#instanceName || '';
    const magicLinkUrl = `${baseUrl}${this.#prefix}/${instanceName}/magic-link?one_time_token=${token}`;

    const isTestMode = this.#isTestMode && url.searchParams.get('_test') === 'true';

    if (isTestMode) {
      return Response.json({
        message: 'Magic link generated (test mode)',
        magic_link: magicLinkUrl,
        expires_in: MAGIC_LINK_TTL
      });
    }

    // Send email (fire-and-forget, errors don't block)
    try {
      await this.#sendEmail({
        type: 'magic-link',
        to: email,
        magicLinkUrl,
      });
    } catch (error) {
      const log = debug('nebula-auth.NebulaAuth');
      log.error('Failed to send magic link email', {
        error: error instanceof Error ? error.message : String(error),
        email
      });
    }

    return Response.json({
      message: 'Check your email for the magic link',
      expires_in: MAGIC_LINK_TTL
    });
  }

  async #handleMagicLink(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('one_time_token');

    if (!token) {
      return this.#errorResponse(400, 'invalid_request', 'Missing one_time_token');
    }

    const rows = this.#sql`
      SELECT token, email, expiresAt, used
      FROM MagicLinks
      WHERE token = ${token}
    ` as MagicLink[];

    if (rows.length === 0) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Invalid magic link token', { reason: 'not_found' });
      return this.#redirectWithError('invalid_token');
    }

    const magicLink = rows[0];

    if (magicLink.used) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Used magic link token', { reason: 'token_used', email: magicLink.email });
      return this.#redirectWithError('token_used');
    }

    if (Date.now() > magicLink.expiresAt) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Expired magic link token', { reason: 'token_expired', email: magicLink.email });
      return this.#redirectWithError('token_expired');
    }

    // Delete the token (single-use)
    this.#sql`DELETE FROM MagicLinks WHERE token = ${token}`;

    // Check if subject already has emailVerified (skip registry if so)
    const preVerifyRows = this.#sql`
      SELECT emailVerified FROM Subjects WHERE email = ${magicLink.email}
    ` as any[];
    const wasAlreadyVerified = preVerifyRows.length > 0 && preVerifyRows[0].emailVerified;

    // Get or create subject, apply founder/bootstrap promotion
    const subject = this.#loginSubject(magicLink.email);

    // NA→R: register email→scope on first verification only
    if (!wasAlreadyVerified && this.#instanceName) {
      try {
        await this.#registry.registerEmail(
          subject.email, this.#instanceName, subject.isAdmin,
        );
      } catch (error) {
        const regLog = debug('nebula-auth.NebulaAuth.registry');
        regLog.error('Failed to register email in registry', {
          error: error instanceof Error ? error.message : String(error),
          email: subject.email,
          instanceName: this.#instanceName,
        });
      }
    }

    const loginLog = debug('nebula-auth.NebulaAuth.login.succeeded');
    loginLog.info('Magic link login', { targetSub: subject.sub, actorSub: 'system', email: magicLink.email });

    // Notify admins about non-approved signups
    if (!subject.adminApproved && !subject.isAdmin) {
      await this.#notifyAdminsOfSignup(subject, url);
    }

    const refreshToken = await this.#generateRefreshToken(subject.sub);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': this.#redirect,
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken)
      }
    });
  }

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

    const subjectRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${storedToken.subjectId}
    ` as any[];

    if (subjectRows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Subject not found');
    }

    const subject = this.#rowToSubject(subjectRows[0]);

    const newAccessToken = await this.#generateAccessToken(subject);
    const newRefreshToken = await this.#generateRefreshToken(storedToken.subjectId);

    return new Response(JSON.stringify({
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      sub: subject.sub,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': this.#createRefreshTokenCookie(newRefreshToken)
      }
    });
  }

  async #handleLogout(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');

    if (refreshToken) {
      const tokenHash = await hashString(refreshToken);
      const tokenRows = this.#sql`
        SELECT subjectId FROM RefreshTokens WHERE tokenHash = ${tokenHash}
      ` as any[];
      this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE tokenHash = ${tokenHash}`;
      if (tokenRows.length > 0) {
        const auditLog = debug('nebula-auth.NebulaAuth.token.revoked');
        auditLog.warn('Logout', { targetSub: tokenRows[0].subjectId, actorSub: tokenRows[0].subjectId, method: 'logout' });
      }
    }

    const instanceName = this.#instanceName || '';
    const cookiePath = `${this.#prefix}/${instanceName}`;

    return new Response(JSON.stringify({ message: 'Logged out' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `refresh-token=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      }
    });
  }

  // ============================================
  // Admin Subject Management
  // ============================================

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

  async #handleUpdateSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'PATCH /subject/:id');

    if (auth.sub === subjectId) {
      return this.#errorResponse(403, 'forbidden', 'Cannot modify own admin status');
    }

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

    if (body.authorizedActors !== undefined) {
      return this.#errorResponse(400, 'invalid_request', 'Use POST /subject/:id/actors and DELETE /subject/:id/actors/:actorId to manage authorized actors');
    }

    const auditLog = debug('nebula-auth.NebulaAuth.subject.updated');
    let roleChanged = false;

    if (body.isAdmin !== undefined) {
      // NA→R: registry-first — notify registry of role change
      if (this.#instanceName && body.isAdmin !== Boolean(targetRows[0].isAdmin)) {
        await this.#registry.updateEmailRole(
          targetRows[0].email, this.#instanceName, body.isAdmin,
        );
        roleChanged = true;
      }

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
      if (!body.adminApproved) {
        this.#revokeAllTokensForSubject(subjectId);
        const revokeLog = debug('nebula-auth.NebulaAuth.token.revoked');
        revokeLog.warn('Tokens revoked on approval revocation', { targetSub: subjectId, actorSub: auth.sub, method: 'approval_revoked' });
      }
    }

    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  async #handleDeleteSubject(request: Request, subjectId: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'DELETE /subject/:id');

    if (auth.sub === subjectId) {
      return this.#errorResponse(403, 'forbidden', 'Cannot delete yourself');
    }

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

    // NA→R: registry-first — remove email→scope before local delete
    if (this.#instanceName) {
      await this.#registry.removeEmail(targetEmail, this.#instanceName);
    }

    this.#revokeAllTokensForSubject(subjectId);
    this.#sql`DELETE FROM Subjects WHERE sub = ${subjectId}`;
    this.#sql`DELETE FROM MagicLinks WHERE email = ${targetEmail}`;
    this.#sql`DELETE FROM InviteTokens WHERE email = ${targetEmail}`;

    const auditLog = debug('nebula-auth.NebulaAuth.subject.deleted');
    auditLog.warn('Subject deleted', { targetSub: subjectId, actorSub: auth.sub, email: targetEmail });

    return new Response(null, { status: 204 });
  }

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

    const principalRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${principalSub}` as any[];
    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    const actorRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${actorSub}` as any[];
    if (actorRows.length === 0) {
      return this.#errorResponse(400, 'invalid_request', `Actor ID not found: ${actorSub}`);
    }

    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO AuthorizedActors (principalSub, actorSub) VALUES (?, ?)',
      principalSub, actorSub
    );

    const auditLogAdd = debug('nebula-auth.NebulaAuth.actor.added');
    auditLogAdd.info('Authorized actor added', { targetSub: principalSub, actorSub, adminSub: auth.sub });

    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${principalSub}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  async #handleRemoveActor(request: Request, principalSub: string, actorSub: string): Promise<Response> {
    const auth = await this.#authenticateRequest(request);
    if (!auth.isAdmin) return this.#accessDenied(auth.sub, 'DELETE /subject/:id/actors/:actorId');

    const principalRows = this.#sql`SELECT sub FROM Subjects WHERE sub = ${principalSub}` as any[];
    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    this.#sql`DELETE FROM AuthorizedActors WHERE principalSub = ${principalSub} AND actorSub = ${actorSub}`;

    const auditLogRemove = debug('nebula-auth.NebulaAuth.actor.removed');
    auditLogRemove.info('Authorized actor removed', { targetSub: principalSub, actorSub, adminSub: auth.sub });

    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${principalSub}
    ` as any[];

    return Response.json({ subject: this.#rowToSubject(freshRows[0]) });
  }

  async #handleApprove(request: Request, subjectId: string): Promise<Response> {
    let auth: { sub: string; isAdmin: boolean; email: string };
    try {
      auth = await this.#authenticateRequest(request);
    } catch (error) {
      if (error instanceof AuthenticationError) {
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

    const rows = this.#sql`
      SELECT sub, email, adminApproved FROM Subjects WHERE sub = ${subjectId}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    this.#sql`UPDATE Subjects SET adminApproved = 1 WHERE sub = ${subjectId}`;

    const auditLog = debug('nebula-auth.NebulaAuth.subject.updated');
    auditLog.info('Subject approved', { targetSub: subjectId, actorSub: auth.sub, field: 'adminApproved', from: Boolean(rows[0].adminApproved), to: true });

    try {
      await this.#sendEmail({
        type: 'approval-confirmation',
        to: rows[0].email,
        redirectUrl: this.#redirect,
      });
    } catch (error) {
      const log = debug('nebula-auth.NebulaAuth');
      log.error('Failed to send approval confirmation email', {
        error: error instanceof Error ? error.message : String(error),
        email: rows[0].email
      });
    }

    return new Response(null, {
      status: 302,
      headers: { 'Location': this.#redirect }
    });
  }

  // ============================================
  // Invite & Delegation Endpoints
  // ============================================

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

    // Founding admin rule: if DO has zero subjects, only one email allowed
    const countRows = this.#sql`SELECT COUNT(*) as cnt FROM Subjects` as any[];
    if (countRows[0].cnt === 0) {
      if (emails.length !== 1) {
        return this.#errorResponse(400, 'founding_admin_required',
          'Instance has no subjects — invite exactly one founding admin first, or use claim-universe/claim-star for self-signup.');
      }
    }

    const isTestMode = this.#isTestMode && url.searchParams.get('_test') === 'true';
    const invited: string[] = [];
    const errors: Array<{ email: string; error: string }> = [];
    const links: Record<string, string> = {};
    const instanceName = this.#instanceName || '';

    for (const rawEmail of emails) {
      const email = rawEmail?.toLowerCase().trim();
      if (!email || !this.#isValidEmail(email)) {
        errors.push({ email: rawEmail, error: 'Invalid email format' });
        continue;
      }

      try {
        // Determine if this invitee should be founding admin (zero subjects before this invite)
        const isFoundingAdmin = countRows[0].cnt === 0 && invited.length === 0;

        const existingRows = this.#sql`
          SELECT sub, email, emailVerified, adminApproved FROM Subjects WHERE email = ${email}
        ` as any[];

        if (existingRows.length > 0) {
          const existing = existingRows[0];
          this.#sql`UPDATE Subjects SET adminApproved = 1 WHERE sub = ${existing.sub}`;

          // Founding admin promotion for existing-but-unverified subject
          if (isFoundingAdmin) {
            this.#sql`UPDATE Subjects SET isAdmin = 1, adminApproved = 1 WHERE sub = ${existing.sub}`;
          }

          if (existing.emailVerified) {
            // NA→R: update registry (adminApproved changed, possibly isAdmin too)
            try {
              const freshAdmin = isFoundingAdmin || Boolean(existing.isAdmin);
              await this.#registry.registerEmail(email, instanceName, freshAdmin);
            } catch (error) {
              const regLog = debug('nebula-auth.NebulaAuth.registry');
              regLog.error('Registry registerEmail failed during invite', { error: error instanceof Error ? error.message : String(error), email });
            }

            if (isTestMode) {
              links[email] = '(already verified)';
            } else {
              try {
                await this.#sendEmail({
                  type: 'invite-existing',
                  to: email,
                  redirectUrl: this.#redirect,
                });
              } catch (error) {
                const log = debug('nebula-auth.NebulaAuth');
                log.error('Failed to send invite email', { error: error instanceof Error ? error.message : String(error), email });
              }
            }
            const inviteLog = debug('nebula-auth.NebulaAuth.invite.sent');
            inviteLog.info('Invite sent', { targetSub: existing.sub, actorSub: auth.sub, email });
            invited.push(email);
            continue;
          }
        } else {
          const sub = generateUuid();
          const now = Date.now();
          const subIsAdmin = isFoundingAdmin ? 1 : 0;
          this.#sql`
            INSERT INTO Subjects (sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt)
            VALUES (${sub}, ${email}, 0, 1, ${subIsAdmin}, ${now}, ${null})
          `;
          const createdLog = debug('nebula-auth.NebulaAuth.subject.created');
          createdLog.info('Subject created via invite', { targetSub: sub, actorSub: auth.sub, email, isFoundingAdmin });
        }

        // NA→R: pre-register email→scope in registry
        try {
          const freshRows = this.#sql`SELECT isAdmin FROM Subjects WHERE email = ${email}` as any[];
          const freshIsAdmin = freshRows.length > 0 && Boolean(freshRows[0].isAdmin);
          await this.#registry.registerEmail(email, instanceName, freshIsAdmin);
        } catch (error) {
          const regLog = debug('nebula-auth.NebulaAuth.registry');
          regLog.error('Registry registerEmail failed during invite', { error: error instanceof Error ? error.message : String(error), email });
        }

        const token = generateRandomString(32);
        const expiresAt = Date.now() + (INVITE_TTL * 1000);
        this.#sql`
          INSERT INTO InviteTokens (token, email, expiresAt)
          VALUES (${token}, ${email}, ${expiresAt})
        `;

        const inviteUrl = `${url.origin}${this.#prefix}/${instanceName}/accept-invite?invite_token=${token}`;

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
            const log = debug('nebula-auth.NebulaAuth');
            log.error('Failed to send invite email', { error: error instanceof Error ? error.message : String(error), email });
          }
        }

        const inviteLog = debug('nebula-auth.NebulaAuth.invite.sent');
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

  async #handleAcceptInvite(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('invite_token');

    if (!token) {
      return this.#errorResponse(400, 'invalid_request', 'Missing invite_token');
    }

    const rows = this.#sql`
      SELECT token, email, expiresAt FROM InviteTokens WHERE token = ${token}
    ` as any[];

    if (rows.length === 0) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Invalid invite token', { reason: 'not_found' });
      return this.#redirectWithError('invalid_token');
    }

    const inviteToken = rows[0];

    if (Date.now() > inviteToken.expiresAt) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Expired invite token', { reason: 'token_expired', email: inviteToken.email });
      return this.#redirectWithError('token_expired');
    }

    const subjectRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE email = ${inviteToken.email}
    ` as any[];

    if (subjectRows.length === 0) {
      const auditLog = debug('nebula-auth.NebulaAuth.login.failed');
      auditLog.warn('Invite token for missing subject', { reason: 'subject_not_found', email: inviteToken.email });
      return this.#redirectWithError('invalid_token');
    }

    const sub = subjectRows[0].sub;
    const now = Date.now();

    this.#sql`UPDATE Subjects SET emailVerified = 1, lastLoginAt = ${now} WHERE sub = ${sub}`;

    const loginLog = debug('nebula-auth.NebulaAuth.login.succeeded');
    loginLog.info('Invite accepted', { targetSub: sub, actorSub: 'system', email: inviteToken.email });

    if (!subjectRows[0].emailVerified) {
      const updateLog = debug('nebula-auth.NebulaAuth.subject.updated');
      updateLog.info('Email verified via invite', { targetSub: sub, actorSub: 'system', field: 'emailVerified', from: false, to: true });
    }

    const refreshToken = await this.#generateRefreshToken(sub);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': this.#redirect,
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken)
      }
    });
  }

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

    const principalRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${actFor}
    ` as any[];

    if (principalRows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    const principal = this.#rowToSubject(principalRows[0]);

    if (!auth.isAdmin) {
      const actorRows = this.#sql`
        SELECT 1 FROM AuthorizedActors WHERE principalSub = ${actFor} AND actorSub = ${auth.sub}
      ` as any[];
      if (actorRows.length === 0) {
        const auditLog = debug('nebula-auth.NebulaAuth.access.denied');
        auditLog.warn('Unauthorized delegation attempt', { sub: auth.sub, endpoint: 'POST /delegated-token', targetSub: actFor });
        return this.#errorResponse(403, 'forbidden', 'Not authorized to act for this subject');
      }
    }

    const accessToken = await this.#generateAccessToken(principal, auth.sub);

    const auditLog = debug('nebula-auth.NebulaAuth.token.delegated');
    auditLog.info('Delegated token issued', { targetSub: actFor, actorSub: auth.sub, principalSub: actFor });

    return Response.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL
    });
  }

  // ============================================
  // Test-Only Endpoints
  // ============================================

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

    const rows = this.#sql`
      SELECT sub FROM Subjects WHERE email = ${email}
    ` as any[];

    if (rows.length === 0) {
      return this.#errorResponse(404, 'not_found', 'Subject not found');
    }

    const sub = rows[0].sub;

    if (body.adminApproved !== undefined) {
      this.#sql`UPDATE Subjects SET adminApproved = ${body.adminApproved ? 1 : 0} WHERE sub = ${sub}`;
    }
    if (body.isAdmin !== undefined) {
      this.#sql`UPDATE Subjects SET isAdmin = ${body.isAdmin ? 1 : 0}, adminApproved = 1 WHERE sub = ${sub}`;
    }

    return new Response(null, { status: 204 });
  }

  // ============================================
  // Public RPC method — called by Registry (R→NA)
  // ============================================

  /**
   * Create a subject and send a magic link email. Called by NebulaAuthRegistry
   * during self-signup (claimUniverse, claimStar).
   *
   * The registry has already recorded the instance — this method does NOT
   * call back to the registry (avoids circular RPC).
   *
   * In test mode, returns the magic link URL directly.
   */
  async createSubjectAndSendMagicLink(
    email: string,
    instanceName: string,
    origin: string,
  ): Promise<{ magicLinkUrl: string }> {
    this.#ensureSchema();

    // Set instanceName if not already set (first RPC call, no prior fetch)
    if (!this.#instanceName) {
      this.#instanceName = instanceName;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const token = generateRandomString(32);
    const expiresAt = Date.now() + (MAGIC_LINK_TTL * 1000);

    this.#sql`
      INSERT INTO MagicLinks (token, email, expiresAt, used)
      VALUES (${token}, ${normalizedEmail}, ${expiresAt}, 0)
    `;

    const magicLinkUrl = `${origin}${this.#prefix}/${instanceName}/magic-link?one_time_token=${token}`;

    // Send email (skip in test mode — caller will use the returned URL)
    if (!this.#isTestMode) {
      try {
        await this.#sendEmail({
          type: 'magic-link',
          to: normalizedEmail,
          magicLinkUrl,
        });
      } catch (error) {
        const log = debug('nebula-auth.NebulaAuth');
        log.error('Failed to send magic link email (R→NA)', {
          error: error instanceof Error ? error.message : String(error),
          email: normalizedEmail,
        });
      }
    }

    return { magicLinkUrl };
  }

  // ============================================
  // Authentication
  // ============================================

  async #authenticateRequest(request: Request): Promise<
    { sub: string; isAdmin: boolean; email: string }
  > {
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        const token = parts[1];
        const identity = await this.#verifyBearerToken(token);
        if (identity) return identity;
        const auditLog = debug('nebula-auth.NebulaAuth.access.denied');
        auditLog.warn('Invalid or expired access token', { reason: 'invalid_token' });
        throw new AuthenticationError(401, 'invalid_token', 'Invalid or expired access token');
      }
    }

    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');
    if (refreshToken) {
      const identity = await this.#verifyRefreshTokenIdentity(refreshToken);
      if (identity) return identity;
    }

    const auditLog = debug('nebula-auth.NebulaAuth.access.denied');
    auditLog.warn('Authentication required', { reason: 'no_valid_credential' });
    throw new AuthenticationError(401, 'invalid_token', 'Authentication required');
  }

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

  #revokeAllTokensForSubject(subjectId: string): void {
    this.#sql`UPDATE RefreshTokens SET revoked = 1 WHERE subjectId = ${subjectId}`;
  }

  async #sendEmail(message: any): Promise<void> {
    const sender = (this.env as any).AUTH_EMAIL_SENDER;
    if (sender) {
      await sender.send(message);
    } else {
      const log = debug('nebula-auth.NebulaAuth');
      log.debug(`Email not sent (AUTH_EMAIL_SENDER not configured)`, { type: message.type, to: message.to });
    }
  }

  async #notifyAdminsOfSignup(subject: Subject, url: URL): Promise<void> {
    const instanceName = this.#instanceName || '';
    const adminRows = this.#sql`SELECT email FROM Subjects WHERE isAdmin = 1` as any[];
    if (adminRows.length === 0) return;

    const approveUrl = `${url.origin}${this.#prefix}/${instanceName}/approve/${subject.sub}`;

    for (const admin of adminRows) {
      try {
        await this.#sendEmail({
          type: 'admin-notification',
          to: admin.email,
          subjectEmail: subject.email,
          approveUrl,
        });
      } catch (error) {
        const log = debug('nebula-auth.NebulaAuth');
        log.error('Failed to send admin notification', {
          error: error instanceof Error ? error.message : String(error),
          adminEmail: admin.email,
          subjectEmail: subject.email
        });
      }
    }
  }

  /**
   * Get or create subject, set emailVerified, apply bootstrap + founder promotion.
   *
   * KEY DIFFERENCE from @lumenize/auth: First-user-is-founder logic.
   * When zero subjects exist, the first verified email becomes founding admin
   * (isAdmin=1, adminApproved=1, emailVerified=1).
   *
   * Bootstrap email (NEBULA_AUTH_BOOTSTRAP_EMAIL) is also promoted to admin
   * when it appears at the reserved nebula-platform instance.
   */
  #loginSubject(email: string): Subject {
    const normalizedEmail = email.toLowerCase();
    const now = Date.now();
    const instanceName = this.#instanceName || '';
    const isBootstrap = this.#bootstrapEmail === normalizedEmail;

    // Check if this DO has zero subjects (first-user-is-founder)
    const countRows = this.#sql`SELECT COUNT(*) as cnt FROM Subjects` as any[];
    const subjectCount = countRows[0].cnt;

    const existingRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects
      WHERE email = ${normalizedEmail}
    ` as any[];

    let sub: string;

    if (existingRows.length > 0) {
      sub = existingRows[0].sub;
    } else {
      sub = generateUuid();
      this.#sql`
        INSERT INTO Subjects (sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt)
        VALUES (${sub}, ${normalizedEmail}, 0, 0, 0, ${now}, ${now})
      `;
      const auditLog = debug('nebula-auth.NebulaAuth.subject.created');
      auditLog.info('Subject created via magic link', { targetSub: sub, actorSub: 'system', email: normalizedEmail });
    }

    // Determine if this user should be promoted to admin
    const shouldPromote = isBootstrap || (subjectCount === 0 && existingRows.length === 0);

    if (shouldPromote) {
      if (existingRows.length === 0 || !existingRows[0].isAdmin) {
        const auditLog = debug('nebula-auth.NebulaAuth.subject.updated');
        const reason = isBootstrap ? 'Bootstrap promotion' : 'First-user-is-founder promotion';
        auditLog.info(reason, { targetSub: sub, actorSub: 'system', field: 'isAdmin', from: false, to: true, instanceName });
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

    const freshRows = this.#sql`
      SELECT sub, email, emailVerified, adminApproved, isAdmin, createdAt, lastLoginAt
      FROM Subjects WHERE sub = ${sub}
    ` as any[];

    return this.#rowToSubject(freshRows[0]);
  }

  #rowToSubject(row: any): Subject {
    return {
      ...row,
      emailVerified: Boolean(row.emailVerified),
      adminApproved: Boolean(row.adminApproved),
      isAdmin: Boolean(row.isAdmin),
    };
  }

  /**
   * Generate access token with nebula-specific claims.
   * KEY DIFFERENCE from @lumenize/auth: uses `access: AccessEntry` instead of
   * flat emailVerified/isAdmin/adminApproved claims.
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
    const instanceName = this.#instanceName || '';

    // Build access claim using buildAccessId
    const accessId = buildAccessId(instanceName);
    const access: AccessEntry = { id: accessId };
    if (subject.isAdmin) {
      access.admin = true;
    }

    const now = Math.floor(Date.now() / 1000);
    const payload: NebulaJwtPayload = {
      iss: NEBULA_AUTH_ISSUER,
      aud: NEBULA_AUTH_AUDIENCE,
      sub: subject.sub,
      exp: now + ACCESS_TOKEN_TTL,
      iat: now,
      jti: generateUuid(),
      adminApproved: subject.adminApproved,
      access,
      ...(actorSub ? { act: { sub: actorSub } } : {}),
    };

    return signJwt(payload as any, privateKey, activeKey);
  }

  async #generateRefreshToken(subjectId: string): Promise<string> {
    const token = generateRandomString(32);
    const tokenHash = await hashString(token);
    const now = Date.now();
    const expiresAt = now + (REFRESH_TOKEN_TTL * 1000);

    this.#sql`
      INSERT INTO RefreshTokens (tokenHash, subjectId, expiresAt, createdAt, revoked)
      VALUES (${tokenHash}, ${subjectId}, ${expiresAt}, ${now}, 0)
    `;

    return token;
  }

  /**
   * Create a path-scoped secure cookie for the refresh token.
   * KEY DIFFERENCE: Path={prefix}/{instanceName} instead of Path=/
   */
  #createRefreshTokenCookie(token: string): string {
    const instanceName = this.#instanceName || '';
    const cookiePath = `${this.#prefix}/${instanceName}`;
    return `refresh-token=${token}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_TOKEN_TTL}`;
  }

  #redirectWithError(error: string): Response {
    const separator = this.#redirect.includes('?') ? '&' : '?';
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${this.#redirect}${separator}error=${error}` }
    });
  }

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

  #isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  #accessDenied(sub: string, endpoint: string): Response {
    const auditLog = debug('nebula-auth.NebulaAuth.access.denied');
    auditLog.warn('Non-admin access denied', { sub, endpoint });
    return this.#errorResponse(403, 'forbidden', 'Admin access required');
  }

  #errorResponse(status: number, error: string, description: string): Response {
    const body: AuthError = { error, error_description: description };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
