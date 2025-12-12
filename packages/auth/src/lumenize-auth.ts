import '@lumenize/core';
import { LumenizeBase } from '@lumenize/lumenize-base';
import { ALL_SCHEMAS } from './schemas';
import type { AuthEnv, User, MagicLink, RefreshToken, LoginResponse, AuthError, AuthConfig, EmailService } from './types';
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
 * Extended configuration with rate limiting
 */
interface AuthConfigExtended extends AuthConfig {
  /** Max magic link requests per email per hour (default: 5) */
  rateLimitPerHour?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<AuthConfigExtended> = {
  issuer: 'https://lumenize.local',
  audience: 'https://lumenize.local',
  accessTokenTtl: 900, // 15 minutes
  refreshTokenTtl: 2592000, // 30 days
  magicLinkTtl: 1800, // 30 minutes
  rateLimitPerHour: 5, // 5 requests per hour per email
};

/**
 * LumenizeAuth - Durable Object for authentication
 * 
 * Provides magic link login, JWT access tokens, and refresh token rotation.
 * 
 * Endpoints:
 * - GET /auth/enter - Returns login form (or redirect to form)
 * - POST /auth/email-magic-link - Request magic link
 * - GET /auth/magic-link - Validate magic link and login
 * - POST /auth/refresh-token - Refresh access token
 * - POST /auth/logout - Revoke refresh token
 */
export class LumenizeAuth extends LumenizeBase<AuthEnv> {
  #schemaInitialized = false;
  #config: Required<AuthConfigExtended> = DEFAULT_CONFIG;
  #emailService: EmailService = new ConsoleEmailService();

  /**
   * Ensure database schema is created
   */
  #ensureSchema(): void {
    if (this.#schemaInitialized) return;
    
    for (const schema of ALL_SCHEMAS) {
      this.ctx.storage.sql.exec(schema);
    }
    
    // Add rate limiting table if not exists
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      )
    `);
    
    this.#schemaInitialized = true;
  }

  /**
   * Configure auth settings
   */
  configure(config: Partial<AuthConfigExtended>): void {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the email service implementation
   */
  setEmailService(service: EmailService): void {
    this.#emailService = service;
  }

  /**
   * HTTP request handler - routes to appropriate endpoint
   */
  async fetch(request: Request): Promise<Response> {
    // Auto-initialize from headers (LumenizeBase)
    await super.fetch(request);

    // Ensure schema exists
    this.#ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;

    const log = this.svc.debug('lmz.auth.LumenizeAuth');

    try {
      // Route to appropriate handler
      if (path.endsWith('/enter') && request.method === 'GET') {
        return this.#handleEnter(request);
      }
      
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
   * GET /auth/enter - Entry point for login flow
   * Returns a simple HTML form or instructions
   */
  #handleEnter(_request: Request): Response {
    // For now, return a simple JSON response indicating the endpoint exists
    // In a real app, this would return an HTML form or redirect
    return Response.json({
      message: 'Login endpoint. POST email to /auth/email-magic-link',
      endpoints: {
        request_magic_link: 'POST /auth/email-magic-link',
        validate_magic_link: 'GET /auth/magic-link?magic-link-token=...&state=...',
        refresh_token: 'POST /auth/refresh-token',
        logout: 'POST /auth/logout'
      }
    });
  }

  /**
   * POST /auth/email-magic-link - Request a magic link
   * Body: { email: string }
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

    // Rate limiting check
    if (!this.#checkRateLimit(email)) {
      return this.#errorResponse(429, 'rate_limit_exceeded', 'Too many requests. Please try again later.');
    }
    
    // Generate magic link token and state
    const token = generateRandomString(32);
    const state = generateRandomString(32);
    const expiresAt = Date.now() + (this.#config.magicLinkTtl * 1000);

    // Store magic link
    this.svc.sql`
      INSERT INTO magic_links (token, state, email, expires_at, used)
      VALUES (${token}, ${state}, ${email}, ${expiresAt}, 0)
    `;

    // Build magic link URL
    const baseUrl = url.origin;
    const magicLinkUrl = `${baseUrl}/auth/magic-link?magic-link-token=${token}&state=${state}`;

    // Check for test mode - return magic link in response instead of sending email
    const isTestMode = this.env.AUTH_TEST_MODE === 'true' && url.searchParams.get('_test') === 'true';
    
    if (isTestMode) {
      return Response.json({
        message: 'Magic link generated (test mode)',
        magic_link: magicLinkUrl,
        expires_in: this.#config.magicLinkTtl
      });
    }

    // Send email via email service
    try {
      await this.#emailService.send(email, magicLinkUrl);
    } catch (error) {
      const log = this.svc.debug('lmz.auth.LumenizeAuth');
      log.error('Failed to send magic link email', { 
        error: error instanceof Error ? error.message : String(error),
        email 
      });
      // Still return success to prevent email enumeration attacks
    }

    return Response.json({
      message: 'Check your email for the magic link',
      expires_in: this.#config.magicLinkTtl
    });
  }

  /**
   * GET /auth/magic-link - Validate magic link and complete login
   * Query params: magic-link-token, state
   */
  async #handleMagicLink(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('magic-link-token');
    const state = url.searchParams.get('state');

    if (!token || !state) {
      return this.#errorResponse(400, 'invalid_request', 'Missing token or state');
    }

    // Look up magic link
    const rows = this.svc.sql`
      SELECT token, state, email, expires_at, used
      FROM magic_links
      WHERE token = ${token}
    ` as MagicLink[];

    if (rows.length === 0) {
      return this.#errorResponse(400, 'invalid_token', 'Invalid or expired magic link');
    }

    const magicLink = rows[0];

    // Validate state (CSRF protection)
    if (magicLink.state !== state) {
      return this.#errorResponse(400, 'invalid_state', 'Invalid state parameter');
    }

    // Check if already used
    if (magicLink.used) {
      return this.#errorResponse(400, 'token_used', 'Magic link already used');
    }

    // Check expiration
    if (Date.now() > magicLink.expires_at) {
      return this.#errorResponse(400, 'token_expired', 'Magic link expired');
    }

    // Mark as used
    this.svc.sql`
      UPDATE magic_links SET used = 1 WHERE token = ${token}
    `;

    // Get or create user
    const user = await this.#getOrCreateUser(magicLink.email);

    // Update last login
    this.svc.sql`
      UPDATE users SET last_login_at = ${Date.now()} WHERE id = ${user.id}
    `;

    // Generate tokens
    const accessToken = await this.#generateAccessToken(user.id);
    const refreshToken = await this.#generateRefreshToken(user.id);

    // Return response with refresh token in cookie
    const response: LoginResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.#config.accessTokenTtl
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken)
      }
    });
  }

  /**
   * POST /auth/refresh-token - Refresh access token using refresh token from cookie
   */
  async #handleRefreshToken(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');

    if (!refreshToken) {
      return this.#errorResponse(401, 'invalid_token', 'No refresh token provided');
    }

    // Hash the token to look up
    const tokenHash = await hashString(refreshToken);

    // Look up refresh token
    const rows = this.svc.sql`
      SELECT token_hash, user_id, expires_at, revoked
      FROM refresh_tokens
      WHERE token_hash = ${tokenHash}
    ` as RefreshToken[];

    if (rows.length === 0) {
      return this.#errorResponse(401, 'invalid_token', 'Invalid refresh token');
    }

    const storedToken = rows[0];

    // Check if revoked
    if (storedToken.revoked) {
      return this.#errorResponse(401, 'token_revoked', 'Refresh token has been revoked');
    }

    // Check expiration
    if (Date.now() > storedToken.expires_at) {
      return this.#errorResponse(401, 'token_expired', 'Refresh token expired');
    }

    // Revoke old refresh token (rotation)
    this.svc.sql`
      UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ${tokenHash}
    `;

    // Generate new tokens
    const newAccessToken = await this.#generateAccessToken(storedToken.user_id);
    const newRefreshToken = await this.#generateRefreshToken(storedToken.user_id);

    const response: LoginResponse = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: this.#config.accessTokenTtl
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
   * POST /auth/logout - Revoke refresh token
   */
  async #handleLogout(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie') || '';
    const refreshToken = this.#extractCookie(cookieHeader, 'refresh-token');

    if (refreshToken) {
      const tokenHash = await hashString(refreshToken);
      
      // Revoke the refresh token
      this.svc.sql`
        UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ${tokenHash}
      `;
    }

    // Clear the cookie
    return new Response(JSON.stringify({ message: 'Logged out' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'refresh-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      }
    });
  }

  // ============================================
  // RPC Methods (for Workers RPC calls)
  // ============================================

  /**
   * Get user by ID (RPC method)
   */
  getUserById(userId: string): User | null {
    this.#ensureSchema();
    
    const rows = this.svc.sql`
      SELECT id, email, created_at, last_login_at
      FROM users
      WHERE id = ${userId}
    ` as User[];

    return rows[0] || null;
  }

  /**
   * Get user by email (RPC method)
   */
  getUserByEmail(email: string): User | null {
    this.#ensureSchema();
    
    const rows = this.svc.sql`
      SELECT id, email, created_at, last_login_at
      FROM users
      WHERE email = ${email.toLowerCase()}
    ` as User[];

    return rows[0] || null;
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get or create a user by email
   */
  async #getOrCreateUser(email: string): Promise<User> {
    const normalizedEmail = email.toLowerCase();
    
    // Try to find existing user
    const existingRows = this.svc.sql`
      SELECT id, email, created_at, last_login_at
      FROM users
      WHERE email = ${normalizedEmail}
    ` as User[];

    if (existingRows.length > 0) {
      return existingRows[0];
    }

    // Create new user
    const userId = generateUuid();
    const now = Date.now();

    this.svc.sql`
      INSERT INTO users (id, email, created_at, last_login_at)
      VALUES (${userId}, ${normalizedEmail}, ${now}, ${now})
    `;

    return {
      id: userId,
      email: normalizedEmail,
      created_at: now,
      last_login_at: now
    };
  }

  /**
   * Generate a signed JWT access token
   */
  async #generateAccessToken(userId: string): Promise<string> {
    const activeKey = this.env.ACTIVE_JWT_KEY || 'BLUE';
    const privateKeyPem = activeKey === 'GREEN' 
      ? this.env.JWT_PRIVATE_KEY_GREEN 
      : this.env.JWT_PRIVATE_KEY_BLUE;

    if (!privateKeyPem) {
      throw new Error(`JWT private key not configured for ${activeKey}`);
    }

    const privateKey = await importPrivateKey(privateKeyPem);
    
    const payload = createJwtPayload({
      issuer: this.#config.issuer,
      audience: this.#config.audience,
      subject: userId,
      expiresInSeconds: this.#config.accessTokenTtl
    });

    return signJwt(payload, privateKey, activeKey);
  }

  /**
   * Generate a refresh token and store its hash
   */
  async #generateRefreshToken(userId: string): Promise<string> {
    const token = generateRandomString(32);
    const tokenHash = await hashString(token);
    const now = Date.now();
    const expiresAt = now + (this.#config.refreshTokenTtl * 1000);

    this.svc.sql`
      INSERT INTO refresh_tokens (token_hash, user_id, expires_at, created_at, revoked)
      VALUES (${tokenHash}, ${userId}, ${expiresAt}, ${now}, 0)
    `;

    return token;
  }

  /**
   * Create a secure cookie for the refresh token
   */
  #createRefreshTokenCookie(token: string): string {
    const maxAge = this.#config.refreshTokenTtl;
    return `refresh-token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

  /**
   * Extract a cookie value from Cookie header
   */
  #extractCookie(cookieHeader: string, name: string): string | null {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [cookieName, cookieValue] = cookie.trim().split('=');
      if (cookieName === name) {
        return cookieValue;
      }
    }
    return null;
  }

  /**
   * Validate email format
   */
  #isValidEmail(email: string): boolean {
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Check and update rate limit for an email
   * Returns true if request is allowed, false if rate limited
   */
  #checkRateLimit(email: string): boolean {
    const key = `rate:${email}`;
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour in milliseconds
    const windowStart = now - windowMs;

    // Get current rate limit record
    const rows = this.svc.sql`
      SELECT count, window_start FROM rate_limits WHERE key = ${key}
    ` as Array<{ count: number; window_start: number }>;

    if (rows.length === 0) {
      // No record - create one
      this.svc.sql`
        INSERT INTO rate_limits (key, count, window_start)
        VALUES (${key}, 1, ${now})
      `;
      return true;
    }

    const record = rows[0];

    // Check if window has expired
    if (record.window_start < windowStart) {
      // Reset window
      this.svc.sql`
        UPDATE rate_limits SET count = 1, window_start = ${now} WHERE key = ${key}
      `;
      return true;
    }

    // Check if under limit
    if (record.count < this.#config.rateLimitPerHour) {
      // Increment count
      this.svc.sql`
        UPDATE rate_limits SET count = count + 1 WHERE key = ${key}
      `;
      return true;
    }

    // Rate limited
    return false;
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

