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
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { enforceScopeReach, requireAdmin } from './nebula-do';

/**
 * NebulaContainer — base class for Nebula container nodes.
 *
 * `onBeforeCall()` enforces the SAME structural scope reach as NebulaDO, via the
 * SAME shared {@link enforceScopeReach} helper (composed, not reimplemented —
 * ADR-007's "one place to audit"): a mesh call is accepted iff the caller is an
 * `access.admin` whose authority covers this node's **instance name**, OR its JWT
 * `aud` is covered by the scope encoded in that name. A DevContainer is always
 * addressed by its `parseId`-valid tenant-scoped name `{u}.{g}.dev` (a star-tier
 * id), never a 64-hex DO id, so the derived scope equals the address the caller
 * must already hold (name == routing-key soundness). No trust-on-first-use lock.
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
    // envelope's metadata.callee before onBeforeCall runs).
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive) — mirrors NebulaDO so the guard
    // path is observable from a debug sink. See nebula-container.test.ts.
    debug('nebula.NebulaContainer.onBeforeCall').debug('entry', { instanceName: name });

    enforceScopeReach(
      name,
      this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined,
    );
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

  /**
   * Tear this container node down — destroy the running container instance AND wipe its storage.
   * The NebulaContainer counterpart of `NebulaDO.teardown` (the deprovision-cascade primitive),
   * `@mesh(requireAdmin)`-gated by the same wall. `destroy()` (from `@cloudflare/containers`) is
   * the NebulaContainer-specific step beyond the DO wipe — it fully stops + removes the container;
   * it's best-effort (a container that never started has nothing to destroy, and an idle container
   * sleeps to zero instances regardless). Stop compute first, then clear the DO store.
   */
  @mesh(requireAdmin)
  async teardown(): Promise<void> {
    try {
      await this.destroy();
    } catch {
      // best-effort: never-started / already-gone container has nothing to destroy.
    }
    await this.ctx.storage.deleteAll();
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
