/**
 * Broadcast — dispatch a continuation to many targets with tree-fanout
 * tier offloading at scale.
 *
 * Available on LumenizeDO subclasses via `this.svc.broadcast(targets, remote, opts?)`.
 *
 * **v2 (this implementation)**: fire-and-forget for the success path; an
 * optional `onResult` partial continuation lets callers route per-target
 * results back to a handler on this DO. The framework appends the
 * call's result to the partial's args via the standard last-argument
 * convention (same as the 4-arg `lmz.call` form). For drop-on-failed-fanout
 * style cleanup: the result is `ClientDisconnectedError.clientInstanceName`
 * for failures; success path is `undefined`.
 *
 * **Two dispatch branches:**
 *
 *   - **Direct loop** (`targets.length <= directThreshold`, default 100):
 *     the calling DO loops over targets and dispatches each with a fresh
 *     `this.lmz.call(...)` 3-arg fire-and-forget. No tier worker involved.
 *     This is the same shape as the documented "broadcast helper" pattern
 *     in `website/docs/mesh/calls.mdx`. Suitable for small fanouts where
 *     the extra hop into a tier worker costs more than it saves.
 *
 *   - **Tree path** (`targets.length > directThreshold`):
 *     the calling DO dispatches the full target list to a recursive
 *     `LumenizeFanoutTier`-style Worker via a service binding named
 *     `LUMENIZE_BROADCAST_TIER` (convention). The Worker partitions
 *     targets into groups of size `branch` (default 6 — matches the
 *     observed Workers RPC per-host concurrent-subrequest cap) and
 *     recurses; at leaves it dispatches directly to each target.
 *
 * **Setup for users:** the tree path requires the user's own Worker
 * entrypoint to extend `LumenizeWorker` (it inherits the `@mesh()
 * __broadcastTier` method automatically) AND to be bound under
 * `LUMENIZE_BROADCAST_TIER` as a service-binding to itself:
 *
 *   "services": [
 *     { "binding": "LUMENIZE_BROADCAST_TIER",
 *       "service": "<your-worker-name>",
 *       "entrypoint": "<your-worker-entrypoint-class>" }
 *   ]
 *
 * Users who only ever broadcast to small fanouts (≤ directThreshold) can
 * skip this setup; the direct path doesn't touch the tier.
 *
 * @see `website/docs/mesh/calls.mdx` — pattern and rationale
 * @see `tasks/fanout-scaling-benchmark.md` — empirical motivation for the
 *      defaults (BRANCH=6, directThreshold=100)
 */

import type { AnyContinuation, OperationChain } from './ocan/index.js';
import { getOperationChain } from './ocan/index.js';

/** A single broadcast destination — a binding + optional instance name. */
export interface BroadcastTarget {
  bindingName: string;
  /** `undefined` for Worker (service-binding) targets per the mesh DO/Worker routing rule. */
  instanceName?: string;
}

/** Options for `svc.broadcast(...)`. */
export interface BroadcastOptions {
  /**
   * Per-tier fanout factor inside the recursive tier worker. Default 6 —
   * matches the observed Workers RPC concurrent-outbound-subrequest cap
   * per isolate (so no tier node ever queues its own outbound calls).
   */
  branch?: number;
  /**
   * If `targets.length <= directThreshold`, dispatch directly from the
   * caller without touching the tier worker. Default 100 — empirically
   * the point where the extra tier hop's overhead starts being repaid
   * by the avoided subrequest-queue tail at the caller.
   *
   * Pass `Infinity` to force direct dispatch at any N (matches the
   * pre-broadcast behavior of e.g. Star.#fanout). Pass `0` to force
   * tier dispatch at any N.
   */
  directThreshold?: number;
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
   *       const target = (result as ClientDisconnectedError).clientInstanceName;
   *       if (target) this.#subscriptions.removeSubscriber(resourceId, target);
   *     }
   *   }
   *   ```
   *
   * Then pass `onResult: this.ctn<this>().onBroadcastResult(resourceId)`. The
   * framework appends `result` at each leaf. `ClientDisconnectedError.clientInstanceName`
   * tells you which target failed; success-path calls don't need a target
   * arg because there's nothing to clean up.
   *
   * Routing detail: in the direct branch the partial runs locally via the
   * 4-arg `lmz.call` form. In the tree branch the tier's
   * `__forwardBroadcastResult` `@mesh()` method on `LumenizeWorker` runs at
   * the leaf, then forwards the substituted chain to `callChain[0]` (this
   * DO) via a fresh `lmz.call`. Either way the user-visible behavior is:
   * "your handler is invoked once per target with the leaf-level result."
   */
  onResult?: AnyContinuation;
}

/** Convention name for the recursive-tier service binding. */
export const BROADCAST_TIER_BINDING = 'LUMENIZE_BROADCAST_TIER';

const DEFAULT_BRANCH = 6;
const DEFAULT_DIRECT_THRESHOLD = 100;

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
    const branch = opts.branch ?? DEFAULT_BRANCH;
    const directThreshold = opts.directThreshold ?? DEFAULT_DIRECT_THRESHOLD;

    if (targets.length === 0) return;

    // Direct path — DO loops and dispatches each target itself. The chain
    // is INHERITED (no newChain) so `originAuth` flows through to each
    // target — Gateways and other callees can authorize the push the same
    // way they would for the originator's direct call.
    //
    // The 4-arg form passes `onErrorOnly: true` so the success-path handler
    // dispatch is skipped — the only thing onResult does for a successful
    // push is run a no-op locally on this DO, which both wastes a CPU slice
    // and (on workerd) appears to keep the originator's invocation alive
    // until the per-target handler chain settles. This matches the
    // errors-only behavior the tree branch's `__forwardBroadcastResult`
    // already implements at the tier worker.
    if (targets.length <= directThreshold) {
      for (const t of targets) {
        if (opts.onResult) {
          doInstance.lmz.call(t.bindingName, t.instanceName, remote, opts.onResult, {
            onErrorOnly: true,
          });
        } else {
          doInstance.lmz.call(t.bindingName, t.instanceName, remote);
        }
      }
      return;
    }

    // Tree path — hand the list off to the tier worker, which recurses.
    // Inherited callContext carries `originAuth` through every recursive
    // hop so leaf-level calls to Gateways still authorize correctly.
    const remoteChain = getOperationChain(remote);
    if (!remoteChain) {
      throw new Error('svc.broadcast: remote must be a continuation (this.ctn<T>().method(...))');
    }
    // If onResult was supplied, also extract and pass its chain so the tier
    // can forward per-target results back to callChain[0] (this DO) via
    // its `__forwardBroadcastResult` helper.
    let onResultChain: OperationChain | undefined;
    if (opts.onResult) {
      onResultChain = getOperationChain(opts.onResult);
      if (!onResultChain) {
        throw new Error('svc.broadcast: opts.onResult must be a continuation');
      }
    }
    doInstance.lmz.call(
      BROADCAST_TIER_BINDING,
      undefined,
      doInstance.ctn().__broadcastTier(targets, remoteChain, branch, onResultChain),
    );
  };
}
