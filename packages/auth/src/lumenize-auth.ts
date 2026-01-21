import { debug } from '@lumenize/debug';
import { LumenizeDO } from '@lumenize/mesh';
import { routeDORequest, type CorsOptions } from '@lumenize/utils';
import { ALL_SCHEMAS } from './schemas';
import type { User, MagicLink, RefreshToken, LoginResponse, AuthError, AuthConfig, EmailService } from './types';
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
 * Default configuration values
 * Note: redirect is intentionally undefined - it must be set via configure()
 */
const DEFAULT_CONFIG: Omit<Required<AuthConfig>, 'redirect' | 'cors'> & { redirect: string | undefined; cors: undefined } = {
  issuer: 'https://lumenize.local',
  audience: 'https://lumenize.local',
  accessTokenTtl: 900, // 15 minutes
  refreshTokenTtl: 2592000, // 30 days
  magicLinkTtl: 1800, // 30 minutes
  rateLimitPerHour: 5, // 5 requests per hour per email
  prefix: '/auth',
  gatewayBindingName: 'LUMENIZE_AUTH',
  instanceName: 'default',
  cors: undefined,
  redirect: undefined, // Must be configured - DO returns 'not_configured' if missing
};

/**
 * Error code returned when LumenizeAuth needs configuration.
 * Used by createAuthRoutes to trigger lazy initialization.
 */
export const AUTH_NOT_CONFIGURED_ERROR = 'not_configured';

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
export class LumenizeAuth extends LumenizeDO {
  #debug = debug(this);
  #schemaInitialized = false;
  #config: Required<AuthConfig> | null = null; // null until configure() called
  #emailService: EmailService = new ConsoleEmailService();
  // Rate limiting uses instance variables, not storage (storage writes are expensive, rate limits are ephemeral)
  #rateLimits = new Map<string, { count: number; windowStart: number }>();

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
   * Configure auth settings
   *
   * Must be called before auth endpoints can be used.
   * createAuthRoutes handles this automatically via lazy initialization.
   */
  configure(config: AuthConfig): void {
    if (!config.redirect) {
      throw new Error('redirect is required in auth config');
    }
    this.#config = { ...DEFAULT_CONFIG, ...config } as Required<AuthConfig>;
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

    // Check config is set - if not, return error so Worker can call configure() and retry
    if (!this.#config) {
      return this.#errorResponse(503, AUTH_NOT_CONFIGURED_ERROR, 'Auth DO not configured. Call configure() first.');
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const log = this.#debug('lmz.auth.LumenizeAuth');

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
    const config = this.#config!;

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
    if (!this.#checkRateLimit(email, config)) {
      return this.#errorResponse(429, 'rate_limit_exceeded', 'Too many requests. Please try again later.');
    }

    // Generate magic link token and state
    const token = generateRandomString(32);
    const state = generateRandomString(32);
    const expiresAt = Date.now() + (config.magicLinkTtl * 1000);

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
        expires_in: config.magicLinkTtl
      });
    }

    // Send email via email service
    try {
      await this.#emailService.send(email, magicLinkUrl);
    } catch (error) {
      const log = this.#debug('lmz.auth.LumenizeAuth');
      log.error('Failed to send magic link email', {
        error: error instanceof Error ? error.message : String(error),
        email
      });
      // Still return success to prevent email enumeration attacks
    }

    return Response.json({
      message: 'Check your email for the magic link',
      expires_in: config.magicLinkTtl
    });
  }

  /**
   * GET /auth/magic-link - Validate magic link and complete login
   * Query params: magic-link-token, state
   */
  async #handleMagicLink(_request: Request, url: URL): Promise<Response> {
    const config = this.#config!;

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

    // Generate refresh token (access token obtained via /refresh-token after redirect)
    const refreshToken = await this.#generateRefreshToken(user.id, config);

    // Return 302 redirect with refresh token in cookie
    // Browser navigates to redirect URL, then SPA calls /refresh-token to get access token
    return new Response(null, {
      status: 302,
      headers: {
        'Location': config.redirect,
        'Set-Cookie': this.#createRefreshTokenCookie(refreshToken, config)
      }
    });
  }

  /**
   * POST /auth/refresh-token - Refresh access token using refresh token from cookie
   */
  async #handleRefreshToken(request: Request): Promise<Response> {
    const config = this.#config!;

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
    const newAccessToken = await this.#generateAccessToken(storedToken.user_id, config);
    const newRefreshToken = await this.#generateRefreshToken(storedToken.user_id, config);

    const response: LoginResponse = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': this.#createRefreshTokenCookie(newRefreshToken, config)
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
  async #generateAccessToken(userId: string, config: Required<AuthConfig>): Promise<string> {
    const activeKey = this.env.PRIMARY_JWT_KEY || 'BLUE';
    const privateKeyPem = activeKey === 'GREEN'
      ? this.env.JWT_PRIVATE_KEY_GREEN
      : this.env.JWT_PRIVATE_KEY_BLUE;

    if (!privateKeyPem) {
      throw new Error(`JWT private key not configured for ${activeKey}`);
    }

    const privateKey = await importPrivateKey(privateKeyPem);

    const payload = createJwtPayload({
      issuer: config.issuer,
      audience: config.audience,
      subject: userId,
      expiresInSeconds: config.accessTokenTtl
    });

    return signJwt(payload, privateKey, activeKey);
  }

  /**
   * Generate a refresh token and store its hash
   */
  async #generateRefreshToken(userId: string, config: Required<AuthConfig>): Promise<string> {
    const token = generateRandomString(32);
    const tokenHash = await hashString(token);
    const now = Date.now();
    const expiresAt = now + (config.refreshTokenTtl * 1000);

    this.svc.sql`
      INSERT INTO refresh_tokens (token_hash, user_id, expires_at, created_at, revoked)
      VALUES (${tokenHash}, ${userId}, ${expiresAt}, ${now}, 0)
    `;

    return token;
  }

  /**
   * Create a secure cookie for the refresh token
   */
  #createRefreshTokenCookie(token: string, config: Required<AuthConfig>): string {
    const maxAge = config.refreshTokenTtl;
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
   *
   * Uses instance variables instead of storage - rate limiting is ephemeral.
   * If DO evicts, limits reset (acceptable: low traffic = not hitting rate limits).
   */
  #checkRateLimit(email: string, config: Required<AuthConfig>): boolean {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour in milliseconds
    const windowStart = now - windowMs;

    const record = this.#rateLimits.get(email);

    if (!record) {
      // No record - create one
      this.#rateLimits.set(email, { count: 1, windowStart: now });
      return true;
    }

    // Check if window has expired
    if (record.windowStart < windowStart) {
      // Reset window
      this.#rateLimits.set(email, { count: 1, windowStart: now });
      return true;
    }

    // Check if under limit
    if (record.count < config.rateLimitPerHour) {
      // Increment count
      record.count++;
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

/**
 * Creates an auth routes handler that wraps routeDORequest with URL rewriting.
 *
 * Translates clean auth URLs to proper DO routing paths:
 * - `/auth/magic-link` → `/auth/LUMENIZE_AUTH/default/magic-link`
 * - `/auth/refresh-token` → `/auth/LUMENIZE_AUTH/default/refresh-token`
 *
 * Handles lazy initialization: if the DO returns 'not_configured' error,
 * calls `configure()` and retries the request. This happens only on the first
 * request after DO eviction, so normal operation has zero overhead.
 *
 * @example
 * ```typescript
 * const authRoutes = createAuthRoutes(env, {
 *   redirect: '/app',
 *   cors: { origin: ['https://app.example.com'] }
 * });
 *
 * const authResponse = await authRoutes(request);
 * if (authResponse) return authResponse;
 * ```
 */
export function createAuthRoutes(
  env: Env,
  options: AuthConfig
): (request: Request) => Promise<Response | undefined> {
  const {
    prefix = '/auth',
    gatewayBindingName = 'LUMENIZE_AUTH',
    instanceName = 'default',
    cors,
  } = options;

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
    // e.g., "/auth/magic-link" → "magic-link"
    const endpointPath = path.slice(cleanPrefix.length + 1) || '';

    // Rewrite URL to include binding and instance name
    // "/auth/magic-link" → "/auth/LUMENIZE_AUTH/default/magic-link"
    const rewrittenPath = `${cleanPrefix}/${gatewayBindingName}/${instanceName}/${endpointPath}`;
    const rewrittenUrl = new URL(request.url);
    rewrittenUrl.pathname = rewrittenPath;

    // Clone the original request before consuming it, so we can retry if needed
    // The body can only be read once, so we need two clones: one for initial attempt, one for retry
    const [requestForFirstAttempt, requestForRetry] = [request.clone(), request.clone()];

    // Create new request with rewritten URL
    // Note: Passing Request as init is valid per Fetch API spec, but workerd types don't reflect this
    const rewrittenRequest = new Request(rewrittenUrl.toString(), requestForFirstAttempt as RequestInit);

    // Route to DO
    let response = await routeDORequest(rewrittenRequest, env, {
      prefix: cleanPrefix,
      cors: cors as CorsOptions,
    });

    if (!response) {
      return undefined;
    }

    // Check for 'not_configured' error - indicates DO needs lazy initialization
    if (response.status === 503) {
      // Clone response to read body without consuming
      const clonedResponse = response.clone();
      try {
        const body = await clonedResponse.json() as { error?: string };
        if (body.error === AUTH_NOT_CONFIGURED_ERROR) {
          // Configure the DO with full options
          const doNamespace = env[gatewayBindingName as keyof Env] as DurableObjectNamespace<LumenizeAuth>;
          if (doNamespace) {
            const stub = doNamespace.get(doNamespace.idFromName(instanceName));
            await (stub as any).configure(options);
          }

          // Retry the original request using the preserved clone
          const retryRequest = new Request(rewrittenUrl.toString(), requestForRetry as RequestInit);
          response = await routeDORequest(retryRequest, env, {
            prefix: cleanPrefix,
            cors: cors as CorsOptions,
          });
        }
      } catch {
        // Not JSON or other error - return original response
      }
    }

    return response ?? undefined;
  };
}

