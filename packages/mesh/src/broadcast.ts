/**
 * Broadcast — dispatch a continuation to many targets.
 *
 * Available on LumenizeDO subclasses via `this.svc.broadcast(targets, remote, opts?)`.
 *
 * Fire-and-forget for the success path; an optional `onResult` partial continuation lets callers
 * route per-target results back to a handler on this DO. The framework appends the call's result
 * to the partial's args via the standard last-argument convention (same as the 4-arg `lmz.call`
 * form). For drop-on-failed-fanout style cleanup: the result is a `ClientDisconnectedError` on a
 * failure and `undefined` on the success path, and WHICH target it came from is
 * `callContext.callee` — the address the framework sent that push to, never anything the reply
 * carries.
 *
 * **One loop at any N.** The calling node dispatches each target itself, with its own
 * `this.lmz.call(...)`, so the sender a receiver sees is always the node that decided to push.
 * This is the same shape as the documented "broadcast helper" pattern in
 * `website/docs/mesh/calls.mdx`. Its tail latency grows with N; the recursive Worker tier that
 * once cut it was removed, and its measurements are in the 2026-06-06 blog post.
 *
 * @see `website/docs/mesh/calls.mdx` — pattern and rationale
 */

import type { AnyContinuation } from './ocan/index.js';

/** A single broadcast destination — a binding + optional instance name. */
export interface BroadcastTarget {
  bindingName: string;
  /** `undefined` for Worker (service-binding) targets per the mesh DO/Worker routing rule. */
  instanceName?: string;
}

/** Options for `svc.broadcast(...)`. */
export interface BroadcastOptions {
  /**
   * Optional per-target result handler — a partial continuation on this DO
   * that the framework completes by appending the call result (success
   * value or Error) via the standard last-argument convention.
   *
   * For drop-on-failed-fanout style cleanup, define a `@mesh()` method on
   * this DO like:
   *
   *   ```ts
   *   @mesh()
   *   onBroadcastResult(resourceId: string, result: unknown): void {
   *     if (result instanceof Error && result.name === 'ClientDisconnectedError') {
   *       const target = this.lmz.callContext.callee?.instanceName;
   *       if (target) this.#subscriptions.removeSubscriber(resourceId, target);
   *     }
   *   }
   *   ```
   *
   * Then pass `onResult: this.ctn<this>().onBroadcastResult(resourceId)`. The
   * framework appends `result` for each target. `callContext.callee`
   * tells you which target failed; success-path calls don't need a target
   * arg because there's nothing to clean up.
   *
   * Routing detail: the partial runs on this node via the 4-arg `lmz.call` form with
   * `onErrorOnly: true`, so your handler is invoked once for each target whose call fails.
   */
  onResult?: AnyContinuation;
}

/**
 * Function type of the broadcast service — what `this.svc.broadcast`
 * resolves to. Matches the `sql` pattern: the registered service IS the
 * callable, not an object with a method.
 */
export type BroadcastFn = (
  targets: BroadcastTarget[],
  remote: AnyContinuation,
  opts?: BroadcastOptions,
) => void;

/** Service factory — invoked by the NADIS registry per LumenizeDO instance. */
export function broadcast(doInstance: any): BroadcastFn {
  return (targets, remote, opts = {}) => {
    // The chain is INHERITED (no newChain) so `originAuth` flows through to each target —
    // Gateways and other callees can authorize the push the same way they would for the
    // originator's direct call.
    //
    // The 4-arg form passes `onErrorOnly: true` so the success-path handler dispatch is skipped —
    // the only thing onResult does for a successful push is run a no-op locally on this DO, which
    // both wastes a CPU slice and (on workerd) appears to keep the originator's invocation alive
    // until the per-target handler chain settles.
    for (const t of targets) {
      if (opts.onResult) {
        doInstance.lmz.call(t.bindingName, t.instanceName, remote, opts.onResult, {
          onErrorOnly: true,
        });
      } else {
        doInstance.lmz.call(t.bindingName, t.instanceName, remote);
      }
    }
  };
}
