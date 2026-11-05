/**
 * GatePairDO — a `@mesh()`-decorated getter and an undecorated one on the same class.
 *
 * From website/docs/mesh/mesh-api.mdx § Decorator: `@mesh()`.
 *
 * The asymmetry is what readers get wrong, so both halves sit side by side: a DECORATED gate is
 * reachable from the wire, an UNDECORATED one is not — and the absence of the decorator is what
 * does the second. Nothing about visibility matters; `settingsForResults` below is `public`.
 *
 * A scoped node, named by its workspace's scope, so its admin check is Mesh's own
 * `requireDominionHere`, and a caller from another workspace is refused by passage before any
 * guard runs. `TeamDocDO` shows the same check on an unscoped node.
 */

import { ScopedMeshDO, mesh, requireDominionHere } from '../../../src/index.js';

/** The capability a gate hands back. Plain methods — no decorator of their own. */
export class Settings {
  #node: GatePairDO;
  constructor(node: GatePairDO) { this.#node = node; }
  read(): string { return (this.#node.stored ?? 'unset') as string; }
  write(value: string): void { this.#node.stored = value; }
}

export class GatePairDO extends ScopedMeshDO<Env> {
  get stored(): string | undefined { return this.ctx.storage.kv.get('setting'); }
  set stored(value: string | undefined) { this.ctx.storage.kv.put('setting', value); }

  /** Set by the undecorated getter's body, so a test can prove the body never ran. */
  get undecoratedGateRan(): boolean { return this.ctx.storage.kv.get('undecorated_ran') === true; }

  // A GETTER gate. The guard runs at the ENTRY op — read off the descriptor, before the getter
  // body is invoked — and the body then picks what to hand back.
  @mesh(requireDominionHere) get settings(): Settings { return new Settings(this); }

  // The same capability, UNDECORATED, so it is unreachable from the wire. An undecorated getter is
  // refused WITHOUT running: the check reads the property's descriptor, never the property.
  get settingsForResults(): Settings { return this.#openResults(); }

  /** Records that the body ran, so a test can prove it never did. Not part of the doc block. */
  #openResults(): Settings {
    this.ctx.storage.kv.put('undecorated_ran', true);
    return new Settings(this);
  }
}
