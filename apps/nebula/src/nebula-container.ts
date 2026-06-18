/**
 * NebulaContainer — the Nebula-layer container node (the 4th Lumenize node type).
 *
 * `extends LumenizeContainer` (a `@cloudflare/containers` Container composing the
 * mesh comms+guards core), and is a **sibling of NebulaDO, not a subclass**: it
 * mirrors NebulaDO's `onBeforeCall` structural tenant-isolation guard
 * (`buildAuthScopePattern` + `matchAccess`) but cannot inherit NebulaDO (that is
 * a `LumenizeDO`; this is a `Container`). The Studio-specific `DevContainer`
 * (vite + preview proxy) is built on this in the #1a dev-loop reshape.
 *
 * @see apps/nebula/src/nebula-do.ts — the guard this mirrors
 * @see tasks/nebula-devcontainer-node-type.md, tasks/nebula-do-scope-isolation.md
 */

import { LumenizeContainer } from '@lumenize/mesh/container';
import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { buildAuthScopePattern, isPlatformInstance, matchAccess } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

/**
 * NebulaContainer — base class for Nebula container nodes.
 *
 * `onBeforeCall()` enforces the SAME structural tenant isolation as NebulaDO: a
 * mesh call is accepted only if its JWT `aud` (active scope) is covered by the
 * scope encoded in this node's **instance name**. A DevContainer is always
 * addressed by its `parseId`-valid tenant-scoped name `{u}.{g}.dev` (a star-tier
 * id), never a 64-hex DO id, so `buildAuthScopePattern(name)` yields exactly the
 * scope the caller must already hold (the name == routing-key soundness). Scope
 * is derived from the name on every call; there is no trust-on-first-use lock.
 *
 * The guard runs ONLY on the mesh path (inside `executeEnvelope`). It does NOT
 * cover `fetch()`/`containerFetch` — by design: `fetch()` serves only the public
 * preview shell (LumenizeContainer pins the public port; no tenant data flows
 * through it), and the agent command channel reaches the command port only via
 * DevContainer's internal `containerFetch`. See § Scope-isolation boundary (M1).
 */
export class NebulaContainer extends LumenizeContainer {
  onBeforeCall(): void {
    // Scope is derived from this node's instance name (stamped from the
    // envelope's metadata.callee before onBeforeCall runs). Absent name ⇒ the
    // call didn't carry callee metadata — fail closed.
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive) — mirrors NebulaDO so the guard
    // path is observable from a debug sink. See nebula-container.test.ts.
    debug('nebula.NebulaContainer.onBeforeCall').debug('entry', { instanceName: name });

    if (!name) {
      throw new Error('Mesh call missing callee instance name');
    }

    // The platform instance name maps to the accept-all pattern `*`; no
    // container node is the platform DO, so reject it before it could collapse
    // the gate.
    if (isPlatformInstance(name)) {
      throw new Error('Active-scope mismatch');
    }

    // Throws on an unparseable name (e.g. >3 segments, illegal slug) — fail
    // closed rather than swallow.
    const pattern = buildAuthScopePattern(name);

    const aud = (this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined)?.aud;
    if (!aud) {
      throw new Error('Missing active scope (aud)');
    }

    // Tenant boundary: the active scope must be covered by this node's scope.
    if (!matchAccess(pattern, aud)) {
      throw new Error('Active-scope mismatch');
    }
  }

  /**
   * The node's initial guarded mesh surface (a trivial scope-gated write): a
   * cross-scope/foreign caller is rejected by `onBeforeCall` before this runs,
   * so it persists nothing. DevContainer (#1a) adds the real agent-facing
   * methods. Uses `ctx.storage.sql` directly — a Container has no `this.svc`,
   * and local DO storage is the correct API in every layer.
   */
  @mesh()
  recordValue(value: string): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ContainerKv (entryKey TEXT PRIMARY KEY, entryValue TEXT NOT NULL) WITHOUT ROWID;`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ContainerKv (entryKey, entryValue) VALUES (?, ?)`,
      'last',
      value,
    );
  }

  /** Read back the value written by {@link recordValue} (scope-gated read). */
  @mesh()
  readValue(): string | undefined {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ContainerKv (entryKey TEXT PRIMARY KEY, entryValue TEXT NOT NULL) WITHOUT ROWID;`,
    );
    const rows = this.ctx.storage.sql
      .exec(`SELECT entryValue FROM ContainerKv WHERE entryKey = ?`, 'last')
      .toArray() as Array<{ entryValue: string }>;
    return rows[0]?.entryValue;
  }
}
