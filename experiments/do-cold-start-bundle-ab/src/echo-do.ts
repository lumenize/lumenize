/**
 * The DO under test — IDENTICAL across both arms.
 *
 * A `LumenizeDO` (not a plain `DurableObject`) so the composition matches what the rest of
 * the cold-start work measured, but with ordinary public methods reached by raw Workers RPC
 * rather than `@mesh()` calls. The Gateway/WebSocket/auth layer is deliberately absent: the
 * questions here are about DO lifecycle cost, and every layer removed is one fewer confounder.
 *
 * TWO IDS make the lifecycle state OBSERVABLE instead of inferred from timing (which is
 * circular when timing is the thing under investigation):
 *
 *   instanceId — regenerated on every DO construction
 *   isolateId  — module scope, so it SURVIVES DO reconstruction within the same isolate
 *
 *   both unchanged            ⇒ nothing was rebuilt; the instance is still resident
 *   instance changed only     ⇒ DO rebuilt, module graph REUSED (cheap)
 *   both changed              ⇒ isolate rebuilt, module graph RE-EVALUATED (the ~850 ms)
 *
 * Both are assigned lazily inside a request rather than at module top level: Workers restrict
 * work at global scope, and a lazy assignment still lands in module scope, so `isolateId`
 * keeps the per-isolate lifetime we need.
 */

import { LumenizeDO } from '@lumenize/mesh';

/** Module scope ⇒ one value per isolate, surviving DO reconstruction within that isolate. */
let ISOLATE_ID: string | undefined;

export class EchoDO extends LumenizeDO {
  #instanceId: string | undefined;

  /** Reached by raw RPC from the worker's fetch handler, not over the mesh. */
  echo(value: unknown): { value: unknown; isolateId: string; instanceId: string } {
    ISOLATE_ID ??= crypto.randomUUID().slice(0, 8);
    this.#instanceId ??= crypto.randomUUID().slice(0, 8);
    return { value, isolateId: ISOLATE_ID, instanceId: this.#instanceId };
  }

  /**
   * Force-evict this instance. `ctx.abort()` is the forced idle-evict (mechanic proven on real
   * CF — see .claude/rules/containers.md): the instance is torn down and the next request
   * reconstructs it. The in-flight RPC dies with it, so the caller MUST tolerate the failure.
   *
   * Nothing is persisted here, so the "persist before abort needs a macrotask yield" hazard in
   * durable-objects.md doesn't apply.
   */
  abortSelf(): void {
    this.ctx.abort();
  }
}
