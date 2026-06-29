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
import { parseId, isValidSlug, isDevAuthoringStar, matchAccess, getParentId } from './parse-id';
import type { AccessEntry, DiscoveryEntry } from './types';

/** One instance in a scope-deletion plan — enough for the client to teardown the right DOs. */
export interface AffectedScope {
  instanceName: string;
  /** 'universe' | 'galaxy' | 'star' — picks the tier DO binding to teardown. */
  tier: string;
  /** A `{u}.{g}.dev` authoring Star → the client also tears down DevStudio + DevContainer. */
  isDev: boolean;
}

/** A reason a scope can't be deleted: another user is attached to an affected scope. */
export interface ScopeDeletionBlocker {
  instanceName: string;
  email: string;
}

/** The read-only deletion plan that feeds the confirm screen. */
export interface ScopeDeletionPlan {
  /** The full cascade set (target + descendants + pruned-up empty ancestors), wipe order. */
  affected: AffectedScope[];
  /** Non-empty → deletion is refused (a shared scope); each entry names who/where. */
  blockedBy: ScopeDeletionBlocker[];
}

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
   *
   * `callerAccess` (the Worker-verified JWT access claim, when present) gates a `.dev`
   * AUTHORING-Star claim to parent-Galaxy admins (m2); other star claims stay open. The Worker
   * router only forwards `callerAccess` for a `.dev` claim, so a missing claim there is a hard
   * reject — never a silent open.
   */
  async claimStar(
    universeGalaxyStarId: string,
    email: string,
    origin: string,
    callerAccess?: AccessEntry,
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

    // m2 (tasks/nebula-release-process.md): claiming a `.dev` AUTHORING Star is gated to
    // parent-Galaxy admins — a non-admin first-toucher would seed an adminless root (star.ts).
    // claim ≠ USE: USING an existing `.dev` Star is governed by DAG grants, not this gate, and
    // non-`.dev` star claims stay open (Turnstile-only). Mirrors createGalaxy's admin-over-parent.
    if (isDevAuthoringStar(universeGalaxyStarId) && !this.#hasAdminOverGalaxy(callerAccess, parentGalaxy)) {
      throw new RegistryError(
        403, 'forbidden',
        `Claiming the "${universeGalaxyStarId}" authoring Star requires admin over the parent galaxy "${parentGalaxy}"`,
      );
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

  /**
   * Create a Star IN-SESSION — registers the instance, NO magic-link email. Distinct from
   * {@link claimStar} (which emails a link, for the original cross-user claim flow): when an admin
   * builds their OWN hierarchy, they already hold a session that reaches the new Star (higher-admin
   * reach) and first access seeds them founder-admin, so a per-Star email would be pure friction.
   * Admin-gated over the parent galaxy (mirrors claimStar's m2 gate). Caller (router) pre-verifies
   * the JWT and passes the verified access claim.
   */
  createStar(universeGalaxyStarId: string, callerAccess: AccessEntry): { instanceName: string } {
    this.#ensureSchema();

    let parsed;
    try {
      parsed = parseId(universeGalaxyStarId);
    } catch {
      throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyStarId format');
    }
    if (parsed.tier !== 'star') {
      throw new RegistryError(400, 'invalid_tier', 'create-star requires a 3-segment id (universe.galaxy.star)');
    }

    const parentGalaxy = `${parsed.universe}.${parsed.galaxy}`;
    if (!this.#hasAdminOverGalaxy(callerAccess, parentGalaxy)) {
      throw new RegistryError(403, 'forbidden', `Caller is not an admin of the parent galaxy "${parentGalaxy}"`);
    }

    const parentRows = this.#sql`SELECT 1 FROM Instances WHERE instanceName = ${parentGalaxy}`;
    if (parentRows.length === 0) {
      throw new RegistryError(400, 'parent_not_found', `Parent galaxy "${parentGalaxy}" does not exist`);
    }

    if (!this.checkSlugAvailable(universeGalaxyStarId)) {
      throw new RegistryError(409, 'slug_taken', `Star "${universeGalaxyStarId}" is already claimed`);
    }

    this.ctx.storage.sql.exec(
      'INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)',
      universeGalaxyStarId, Date.now(),
    );
    debug('nebula-auth.Registry.createStar').info('Star created in-session', { universeGalaxyStarId });
    return { instanceName: universeGalaxyStarId };
  }

  /**
   * The caller's manageable scope tree — every instance under their admin authority (Universe +
   * descendants), for the Scopes hierarchy view. Keyed on the verified admin SCOPE, NOT email:
   * `createGalaxy`/`createStar` register an instance without an email mapping, so `discover` (email-
   * keyed) wouldn't surface a galaxy you just created; this does. Flat list; the client nests by id.
   */
  myScopeTree(callerAccess: AccessEntry): AffectedScope[] {
    this.#ensureSchema();
    if (!callerAccess?.admin) return [];
    const pattern = callerAccess.authScopePattern;
    let rows: any[];
    if (pattern === '*') {
      rows = this.#sql`SELECT instanceName FROM Instances`;
    } else if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      rows = this.#sql`SELECT instanceName FROM Instances WHERE instanceName = ${prefix} OR instanceName LIKE ${prefix + '.%'}`;
    } else {
      rows = this.#sql`SELECT instanceName FROM Instances WHERE instanceName = ${pattern}`;
    }
    return rows.map(r => this.#toAffected(r.instanceName as string));
  }

  // ============================================
  // Scope deletion — cascade teardown (plan + execute)
  // ============================================

  /**
   * Read-only deletion PLAN (feeds the confirm screen). Computes the full cascade — the target +
   * all registered descendants (down), plus any ancestor left with no remaining descendants and no
   * other users (prune up) — and any blockers (another user attached to an affected scope). Throws
   * 403 if the caller isn't admin over the target. Mutates nothing.
   */
  planScopeDeletion(target: string, callerEmail: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    this.#ensureSchema();
    return this.#computeDeletionPlan(target, callerEmail.toLowerCase(), callerAccess);
  }

  /**
   * Execute the cascade: re-verify admin + re-run the guard, then for each affected scope wipe the
   * NebulaAuth subjects (within nebula-auth) and remove the registry `Instances` + `Emails` rows.
   * Returns the affected set so the Worker-side caller fans out platform-DO `teardown()` (the
   * registry cannot reach platform DOs — dependency direction). Throws 403 (not admin) or 409 (a
   * shared scope blocks the delete).
   */
  async executeScopeDeletion(
    target: string, callerEmail: string, callerAccess: AccessEntry,
  ): Promise<{ affected: AffectedScope[] }> {
    this.#ensureSchema();
    const lc = callerEmail.toLowerCase();
    const plan = this.#computeDeletionPlan(target, lc, callerAccess);
    if (plan.blockedBy.length > 0) {
      throw new RegistryError(
        409, 'scope_in_use',
        `Cannot delete: other users are attached to ${plan.blockedBy.map(b => b.instanceName).join(', ')}`,
      );
    }

    const log = debug('nebula-auth.Registry.executeScopeDeletion');
    for (const scope of plan.affected) {
      // Wipe the per-scope NebulaAuth subjects/tokens (registry → NebulaAuth, both nebula-auth).
      const naStub = (this.env as any).NEBULA_AUTH.getByName(scope.instanceName);
      try {
        await naStub.teardownInstance();
      } catch (err) {
        log.warn('NebulaAuth teardown failed (continuing)', {
          instanceName: scope.instanceName, error: err instanceof Error ? err.message : String(err),
        });
      }
      // Remove the registry rows → discovery no longer returns it (the clean-slate effect).
      this.ctx.storage.sql.exec('DELETE FROM Emails WHERE instanceName = ?', scope.instanceName);
      this.ctx.storage.sql.exec('DELETE FROM Instances WHERE instanceName = ?', scope.instanceName);
    }

    log.info('Scope deleted', { target, callerEmail: lc, affected: plan.affected.map(a => a.instanceName) });
    return { affected: plan.affected };
  }

  #computeDeletionPlan(target: string, callerEmailLc: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    if (target === PLATFORM_INSTANCE_NAME) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_INSTANCE_NAME}" cannot be deleted`);
    }
    let parsed;
    try {
      parsed = parseId(target);
    } catch {
      throw new RegistryError(400, 'invalid_id', 'Invalid scope id');
    }

    // Authorization: the caller must be admin over the TARGET (its wildcard covers descendants too).
    if (!this.#hasAdminOverScope(callerAccess, target)) {
      throw new RegistryError(403, 'forbidden', `Caller is not an admin of "${target}"`);
    }

    // Down: the target + all registered descendants.
    const down = this.#sql`
      SELECT instanceName FROM Instances
      WHERE instanceName = ${target} OR instanceName LIKE ${target + '.%'}
    `.map(r => r.instanceName as string);

    // Nothing registered at the target → nothing to delete.
    if (!down.includes(target)) {
      return { affected: [], blockedBy: [] };
    }

    // Guard: any OTHER user on any down-set scope blocks the whole delete (no prune, no wipe).
    const blockedBy = this.#otherUsers(down, callerEmailLc);
    if (blockedBy.length > 0) {
      return { affected: down.map(n => this.#toAffected(n)), blockedBy };
    }

    // Prune up: for each ancestor — wipe it iff the caller admins it AND it's left with no remaining
    // registered descendants outside the wipe set AND no other users. Admin coverage is monotonic
    // up the tree (prefix patterns), so the first un-admined ancestor stops the walk. An ancestor
    // that exists only conceptually (not registered) is skipped but doesn't block the walk upward.
    const wipe = new Set(down);
    let ancestor = getParentId(parsed);
    while (ancestor) {
      if (!this.#hasAdminOverScope(callerAccess, ancestor)) break;
      const isRegistered = this.#sql`SELECT 1 FROM Instances WHERE instanceName = ${ancestor}`.length > 0;
      if (isRegistered) {
        const childrenRemaining = this.#sql`
          SELECT instanceName FROM Instances WHERE instanceName LIKE ${ancestor + '.%'}
        `.map(r => r.instanceName as string).filter(n => !wipe.has(n));
        if (childrenRemaining.length > 0) break; // still has live descendants
        if (this.#otherUsers([ancestor], callerEmailLc).length > 0) break; // someone else uses it
        wipe.add(ancestor);
      }
      ancestor = getParentId(parseId(ancestor));
    }

    const ancestors = [...wipe].filter(n => !down.includes(n));
    return { affected: [...down, ...ancestors].map(n => this.#toAffected(n)), blockedBy: [] };
  }

  #toAffected(instanceName: string): AffectedScope {
    const p = parseId(instanceName);
    return { instanceName, tier: p.tier, isDev: p.tier === 'star' && p.star === 'dev' };
  }

  #otherUsers(instanceNames: string[], callerEmailLc: string): ScopeDeletionBlocker[] {
    const out: ScopeDeletionBlocker[] = [];
    for (const name of instanceNames) {
      const rows = this.#sql`
        SELECT DISTINCT email FROM Emails WHERE instanceName = ${name} AND email != ${callerEmailLc}
      `;
      for (const r of rows) out.push({ instanceName: name, email: r.email as string });
    }
    return out;
  }

  /** Admin over `scope` iff the access claim is admin AND its pattern covers the scope. */
  #hasAdminOverScope(access: AccessEntry | undefined, scope: string): boolean {
    if (!access?.admin) return false;
    return matchAccess(access.authScopePattern, scope);
  }

  // ============================================
  // HTTP fetch handler — public endpoints
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
          // `verifiedAccess` is injected by the Worker router ONLY for a `.dev` authoring-Star
          // claim (after JWT verify) — see router.ts. The registry enforces the parent-admin gate.
          const { universeGalaxyStarId, email, verifiedAccess } = await request.json() as {
            universeGalaxyStarId: string; email: string; verifiedAccess?: AccessEntry;
          };
          const origin = url.origin;
          const result = await this.claimStar(universeGalaxyStarId, email, origin, verifiedAccess);
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
        case 'create-star': {
          const { universeGalaxyStarId, verifiedAccess } = await request.json() as {
            universeGalaxyStarId: string; verifiedAccess?: AccessEntry;
          };
          if (!verifiedAccess) {
            return Response.json(
              { error: 'invalid_request', error_description: 'Missing verified access claim' },
              { status: 400 },
            );
          }
          return Response.json(this.createStar(universeGalaxyStarId, verifiedAccess), { status: 201 });
        }
        case 'my-scopes': {
          const { verifiedAccess } = await request.json() as { verifiedAccess?: AccessEntry };
          if (!verifiedAccess) {
            return Response.json(
              { error: 'invalid_request', error_description: 'Missing verified access claim' },
              { status: 400 },
            );
          }
          return Response.json({ scopes: this.myScopeTree(verifiedAccess) });
        }
        case 'delete-scope-plan': {
          // JWT already verified by router — verified access + caller email injected.
          const { target, verifiedAccess, callerEmail } = await request.json() as {
            target: string; verifiedAccess?: AccessEntry; callerEmail?: string;
          };
          if (!verifiedAccess || !callerEmail) {
            return Response.json(
              { error: 'invalid_request', error_description: 'Missing verified caller identity' },
              { status: 400 },
            );
          }
          return Response.json(this.planScopeDeletion(target, callerEmail, verifiedAccess));
        }
        case 'delete-scope': {
          const { target, verifiedAccess, callerEmail } = await request.json() as {
            target: string; verifiedAccess?: AccessEntry; callerEmail?: string;
          };
          if (!verifiedAccess || !callerEmail) {
            return Response.json(
              { error: 'invalid_request', error_description: 'Missing verified caller identity' },
              { status: 400 },
            );
          }
          return Response.json(await this.executeScopeDeletion(target, callerEmail, verifiedAccess));
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

  /**
   * Check if the caller's access claim grants admin over a galaxy (the parent of a `.dev`
   * authoring Star). Mirrors {@link NebulaAuthRegistry.#hasAdminOverUniverse} one tier down, via
   * the canonical hierarchy matcher: `*` (platform), `u.*` (universe admin — covers the galaxy),
   * `u.g.*` (galaxy admin), or an exact admin `u.g` all qualify. Undefined / non-admin → false.
   */
  #hasAdminOverGalaxy(access: AccessEntry | undefined, galaxyId: string): boolean {
    if (!access?.admin) return false;
    return matchAccess(access.authScopePattern, galaxyId);
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
