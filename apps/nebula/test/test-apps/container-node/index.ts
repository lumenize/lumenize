/**
 * Test harness for NebulaContainer's scope-isolation guard (Phase 3).
 *
 * The Phase-2 precheck proved a `Container`-based node can't be constructed
 * under vitest-pool-workers (no container engine). NebulaContainer extends
 * LumenizeContainer extends Container, so it can't be a real DO here either.
 *
 * `NebulaContainerGuardHarness extends LumenizeDO` (a constructable SQLite DO)
 * and **borrows NebulaContainer's REAL prototype methods** via `.call(this)`:
 * its `onBeforeCall` IS `NebulaContainer.prototype.onBeforeCall`, and its
 * `recordValue`/`readValue` delegate to NebulaContainer's. Both only read
 * `this.lmz` / `this.ctx.storage`, which a LumenizeDO supplies identically, so
 * the guard executes against a real `executeEnvelope` → `runWithCallContext` →
 * stamped-identity path — i.e. a faithful test of the actual guard, not a copy.
 * A mutation to NebulaContainer.onBeforeCall flips these tests RED.
 *
 * No `containers` block / no `ctx.container` needed — NebulaContainer is never
 * instantiated; only its prototype functions are invoked.
 */
import { LumenizeDO, mesh } from '@lumenize/mesh';
import { NebulaContainer } from '../../../src/nebula-container';

export class NebulaContainerGuardHarness extends LumenizeDO<Env> {
  // The unit under test: NebulaContainer's REAL structural-isolation guard.
  override onBeforeCall(): void {
    NebulaContainer.prototype.onBeforeCall.call(this);
  }

  @mesh()
  recordValue(value: string): void {
    (NebulaContainer.prototype.recordValue as (this: unknown, v: string) => void).call(this, value);
  }

  @mesh()
  readValue(): string | undefined {
    return (NebulaContainer.prototype.readValue as (this: unknown) => string | undefined).call(this);
  }
}

export default {
  fetch(): Response {
    return new Response('nebula-container guard harness');
  },
};
