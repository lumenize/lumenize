/**
 * NebulaAuthRegistry — Singleton DO for central instance/email registry
 *
 * Maintains a global index of all NebulaAuth instances and email→scope
 * mappings. Enables slug availability checks, discovery, self-signup,
 * and galaxy creation.
 *
 * Public methods are called via Workers RPC from:
 * - NebulaAuth instances (NA→R): registerEmail, removeEmail, updateEmailRole
 * - Worker router (R endpoints): discover, claimUniverse, claimStar, createGalaxy
 *
 * @see tasks/nebula-auth.md § NebulaAuthRegistry
 */
import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { REGISTRY_SCHEMAS } from './schemas';
import { NEBULA_AUTH_PREFIX, PLATFORM_INSTANCE_NAME } from './types';
import { parseId, isValidSlug } from './parse-id';
import type { AccessEntry, DiscoveryEntry } from './types';

export class NebulaAuthRegistry extends DurableObject {
  #schemaInitialized = false;

  #ensureSchema(): void {
    if (this.#schemaInitialized) return;
    for (const schema of REGISTRY_SCHEMAS) {
      this.ctx.storage.sql.exec(schema);
    }
    this.#schemaInitialized = true;
  }

  #sql(strings: TemplateStringsArray, ...values: any[]): any[] {
    const query = strings.reduce((acc, str, i) =>
      acc + str + (i < values.length ? '?' : ''), '');
    return [...this.ctx.storage.sql.exec(query, ...values)];
  }

  // ============================================
  // NA→R: Called by NebulaAuth instances via RPC
  // ============================================

  /**
   * Register an email→scope mapping. Called by NA on:
   * - First email verification (magic link completion)
   * - Admin invite (pre-register email→scope)
   *
   * Also ensures the instance is recorded in the Instances table.
   */
  registerEmail(email: string, instanceName: string, isAdmin: boolean): void {
    this.#ensureSchema();
    const now = Date.now();

    // Ensure instance exists
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO Instances (instanceName, createdAt) VALUES (?, ?)',
      instanceName, now,
    );

    // Upsert email→scope mapping
    this.ctx.storage.sql.exec(
      `INSERT INTO Emails (email, instanceName, isAdmin, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (email, instanceName) DO UPDATE SET isAdmin = excluded.isAdmin`,
      email.toLowerCase(), instanceName, isAdmin ? 1 : 0, now,
    );

    const log = debug('nebula-auth.Registry.email.registered');
    log.info('Email registered', { email, instanceName, isAdmin });
  }

  /**
   * Remove an email→scope mapping. Called by NA on subject delete.
   */
  removeEmail(email: string, instanceName: string): void {
    this.#ensureSchema();
    this.ctx.storage.sql.exec(
      'DELETE FROM Emails WHERE email = ? AND instanceName = ?',
      email.toLowerCase(), instanceName,
    );
    const log = debug('nebula-auth.Registry.email.removed');
    log.info('Email removed', { email, instanceName });
  }

  /**
   * Update the isAdmin flag for an email→scope mapping.
   * Called by NA on subject role change (PATCH).
   */
  updateEmailRole(email: string, instanceName: string, isAdmin: boolean): void {
    this.#ensureSchema();
    this.ctx.storage.sql.exec(
      'UPDATE Emails SET isAdmin = ? WHERE email = ? AND instanceName = ?',
      isAdmin ? 1 : 0, email.toLowerCase(), instanceName,
    );
    const log = debug('nebula-auth.Registry.email.roleUpdated');
    log.info('Email role updated', { email, instanceName, isAdmin });
  }

  // ============================================
  // Registry-only endpoints
  // ============================================

  /**
   * Email-based scope discovery. Unauthenticated.
   * Returns all scopes an email is associated with.
   */
  discover(email: string): DiscoveryEntry[] {
    this.#ensureSchema();
    const rows = this.#sql`
      SELECT instanceName, isAdmin FROM Emails WHERE email = ${email.toLowerCase()}
    `;
    return rows.map(r => ({
      instanceName: r.instanceName as string,
      isAdmin: Boolean(r.isAdmin),
    }));
  }

  /**
   * Check if a slug/instanceName is available.
   */
  checkSlugAvailable(instanceName: string): boolean {
    this.#ensureSchema();
    const rows = this.#sql`
      SELECT 1 FROM Instances WHERE instanceName = ${instanceName}
    `;
    return rows.length === 0;
  }

  // ============================================
  // Self-signup: R→NA
  // ============================================

  /**
   * Claim a universe slug. Validates availability, records instance,
   * then RPCs to NebulaAuth to create subject and send magic link.
   */
  async claimUniverse(
    slug: string,
    email: string,
    origin: string,
  ): Promise<{ message: string; magicLinkUrl?: string }> {
    this.#ensureSchema();
    const log = debug('nebula-auth.Registry.claimUniverse');

    // Validate email format
    if (!isValidEmail(email)) {
      throw new RegistryError(400, 'invalid_email', 'Invalid email format');
    }

    // Validate slug format
    if (!isValidSlug(slug)) {
      throw new RegistryError(400, 'invalid_slug', 'Invalid universe slug format');
    }

    // Reserved slug check
    if (slug === PLATFORM_INSTANCE_NAME) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_INSTANCE_NAME}" is reserved`);
    }

    // Check availability
    if (!this.checkSlugAvailable(slug)) {
      throw new RegistryError(409, 'slug_taken', `Universe "${slug}" is already claimed`);
    }

    // Record instance
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)',
      slug, now,
    );

    log.info('Universe claimed', { slug, email });

    // R→NA: create subject and send magic link
    const naStub = (this.env as any).NEBULA_AUTH.getByName(slug);
    const result = await naStub.createSubjectAndSendMagicLink(
      email, slug, origin,
    );

    return {
      message: 'Check your email for the magic link',
      magicLinkUrl: result.magicLinkUrl,
    };
  }

  /**
   * Claim a star slug. Validates parent galaxy exists, checks availability,
   * records instance, RPCs to NA.
   */
  async claimStar(
    universeGalaxyStarId: string,
    email: string,
    origin: string,
  ): Promise<{ message: string; magicLinkUrl?: string }> {
    this.#ensureSchema();
    const log = debug('nebula-auth.Registry.claimStar');

    // Validate email format
    if (!isValidEmail(email)) {
      throw new RegistryError(400, 'invalid_email', 'Invalid email format');
    }

    // Validate format — must be exactly 3 segments (star tier)
    let parsed;
    try {
      parsed = parseId(universeGalaxyStarId);
    } catch {
      throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyStarId format');
    }

    if (parsed.tier !== 'star') {
      throw new RegistryError(400, 'invalid_tier', 'claim-star requires a 3-segment id (universe.galaxy.star)');
    }

    // Check parent galaxy exists
    const parentGalaxy = `${parsed.universe}.${parsed.galaxy}`;
    const parentRows = this.#sql`
      SELECT 1 FROM Instances WHERE instanceName = ${parentGalaxy}
    `;
    if (parentRows.length === 0) {
      throw new RegistryError(400, 'parent_not_found', `Parent galaxy "${parentGalaxy}" does not exist`);
    }

    // Check availability
    if (!this.checkSlugAvailable(universeGalaxyStarId)) {
      throw new RegistryError(409, 'slug_taken', `Star "${universeGalaxyStarId}" is already claimed`);
    }

    // Record instance
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)',
      universeGalaxyStarId, now,
    );

    log.info('Star claimed', { universeGalaxyStarId, email });

    // R→NA: create subject and send magic link
    const naStub = (this.env as any).NEBULA_AUTH.getByName(universeGalaxyStarId);
    const result = await naStub.createSubjectAndSendMagicLink(
      email, universeGalaxyStarId, origin,
    );

    return {
      message: 'Check your email for the magic link',
      magicLinkUrl: result.magicLinkUrl,
    };
  }

  /**
   * Create a galaxy. Admin-only — caller (Worker) pre-verifies JWT and
   * passes the verified access claim. Registry checks authorization.
   */
  createGalaxy(
    universeGalaxyId: string,
    callerAccess: AccessEntry,
  ): { instanceName: string } {
    this.#ensureSchema();
    const log = debug('nebula-auth.Registry.createGalaxy');

    // Validate format — must be exactly 2 segments (galaxy tier)
    let parsed;
    try {
      parsed = parseId(universeGalaxyId);
    } catch {
      throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyId format');
    }

    if (parsed.tier !== 'galaxy') {
      throw new RegistryError(400, 'invalid_tier', 'create-galaxy requires a 2-segment id (universe.galaxy)');
    }

    // Authorization: callerAccess must grant admin over the parent universe
    if (!this.#hasAdminOverUniverse(callerAccess, parsed.universe)) {
      throw new RegistryError(403, 'forbidden', 'Caller does not have admin access to the parent universe');
    }

    // Check parent universe exists
    const parentRows = this.#sql`
      SELECT 1 FROM Instances WHERE instanceName = ${parsed.universe}
    `;
    if (parentRows.length === 0) {
      throw new RegistryError(400, 'parent_not_found', `Parent universe "${parsed.universe}" does not exist`);
    }

    // Check availability
    if (!this.checkSlugAvailable(universeGalaxyId)) {
      throw new RegistryError(409, 'slug_taken', `Galaxy "${universeGalaxyId}" is already claimed`);
    }

    // Record instance
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)',
      universeGalaxyId, now,
    );

    log.info('Galaxy created', { universeGalaxyId, callerAccessId: callerAccess.authScopePattern });

    return { instanceName: universeGalaxyId };
  }

  // ============================================
  // HTTP fetch handler — 4 public endpoints
  // ============================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const prefix = NEBULA_AUTH_PREFIX;

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const endpoint = path.slice(prefix.length + 1); // after '/auth/'

    try {
      switch (endpoint) {
        case 'discover': {
          const { email } = await request.json() as { email: string };
          return Response.json(this.discover(email));
        }
        case 'claim-universe': {
          const { slug, email } = await request.json() as { slug: string; email: string };
          const origin = url.origin;
          const result = await this.claimUniverse(slug, email, origin);
          return Response.json(result);
        }
        case 'claim-star': {
          const { universeGalaxyStarId, email } = await request.json() as { universeGalaxyStarId: string; email: string };
          const origin = url.origin;
          const result = await this.claimStar(universeGalaxyStarId, email, origin);
          return Response.json(result);
        }
        case 'create-galaxy': {
          // JWT already verified by router — verified access claim passed in body
          const { universeGalaxyId, verifiedAccess } = await request.json() as {
            universeGalaxyId: string;
            verifiedAccess: AccessEntry;
          };
          if (!verifiedAccess) {
            return Response.json(
              { error: 'invalid_request', error_description: 'Missing verified access claim' },
              { status: 400 },
            );
          }
          const result = this.createGalaxy(universeGalaxyId, verifiedAccess);
          return Response.json(result, { status: 201 });
        }
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        return Response.json(
          { error: err.errorCode, error_description: err.message },
          { status: err.status },
        );
      }
      const log = debug('nebula-auth.Registry.fetch');
      log.error('Unexpected error in registry fetch', { error: err });
      return Response.json(
        { error: 'internal_error', error_description: 'An unexpected error occurred' },
        { status: 500 },
      );
    }
  }

  // ============================================
  // Authorization helpers
  // ============================================

  /**
   * Check if the caller's access claim grants admin over a universe.
   *
   * Valid patterns:
   * - "*" (platform admin) — always grants access
   * - "universe.*" — exact universe match
   * - "universe" with admin=true — exact universe match
   */
  #hasAdminOverUniverse(access: AccessEntry, universe: string): boolean {
    if (!access.admin) return false;

    // Platform admin
    if (access.authScopePattern === '*') return true;

    // Universe wildcard: "universe.*"
    if (access.authScopePattern === `${universe}.*`) return true;

    // Exact universe match (non-wildcard, but still admin)
    if (access.authScopePattern === universe) return true;

    return false;
  }
}

/**
 * Basic email format validation: non-empty local part, @, non-empty domain.
 */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const atIdx = email.indexOf('@');
  return atIdx > 0 && atIdx < email.length - 1;
}

/**
 * Structured error thrown by registry methods.
 * Callers can catch and convert to HTTP responses.
 */
export class RegistryError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.errorCode = errorCode;
  }
}
