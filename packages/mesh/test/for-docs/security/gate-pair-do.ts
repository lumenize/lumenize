/**
 * GatePairDO — a marked getter and an unmarked one on the same class.
 *
 * From website/docs/mesh/mesh-api.mdx § Decorator: `@mesh()`.
 *
 * The asymmetry is what readers get wrong, so both halves sit side by side: a MARKED gate is
 * reachable from the wire, an UNMARKED one is not — and the absence of the decorator is what does
 * the second. Nothing about visibility matters; `settingsForResults` below is `public`.
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

/** Throw to deny. The guard runs at the ENTRY op, before the getter body. */
function requireAdmin(instance: GatePairDO): void {
  if (!instance.lmz.callContext.originAuth?.claims?.isAdmin) {
    throw new Error('Admin access required');
  }
}

/** The capability a gate hands back. Plain methods — no decorator of their own. */
export class Settings {
  #node: GatePairDO;
  constructor(node: GatePairDO) { this.#node = node; }
  read(): string { return (this.#node.stored ?? 'unset') as string; }
  write(value: string): void { this.#node.stored = value; }
}

export class GatePairDO extends LumenizeDO<Env> {
  get stored(): string | undefined { return this.ctx.storage.kv.get('setting'); }
  set stored(value: string | undefined) { this.ctx.storage.kv.put('setting', value); }

  /** Set by the unmarked getter's body, so a test can prove the body never ran. */
  get unmarkedGateRan(): boolean { return this.ctx.storage.kv.get('unmarked_ran') === true; }

  // A GETTER gate. The guard runs at the ENTRY op — read off the descriptor, before the getter
  // body is invoked — and the body then picks what to hand back.
  @mesh(requireAdmin) get settings(): Settings { return new Settings(this); }

  // The same capability, UNMARKED, so it is unreachable from the wire. An unmarked getter is
  // refused WITHOUT running: the check reads the property's descriptor, never the property.
  get settingsForResults(): Settings { return this.#openResults(); }

  /** Records that the body ran, so a test can prove it never did. Not part of the doc block. */
  #openResults(): Settings {
    this.ctx.storage.kv.put('unmarked_ran', true);
    return new Settings(this);
  }
}
