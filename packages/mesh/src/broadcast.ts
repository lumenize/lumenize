/**
 * Broadcast — send one continuation to many targets, one `lmz.call` per target, from the node that
 * decided to push.
 *
 * `this.lmz.broadcast(targets, remote, { onResult })` is a member of every node's `lmz` — a
 * `LumenizeDO`, a `LumenizeWorker`, a `LumenizeClient`, and a node composed with `ComposedMeshDO` —
 * because all it needs is that node's `lmz.call`. The sender a receiver sees is therefore always
 * the node that decided to push, at any N. Its tail latency grows with N; the recursive Worker
 * tier that once cut it was removed, and its measurements are in the 2026-06-06 blog post.
 *
 * **The chain starts fresh by default.** Each target sees a chain that starts at this node and
 * carries no `originAuth`, because a push speaks for the node that sends it, not for whoever's call
 * caused it: a subscriber's page never receives the writer's claims. `newChain: false` makes each
 * target inherit the caller's `callChain` with this node appended, and the caller's `originAuth`,
 * for an app that wants the writer's claims to ride. On a client every call starts at the client,
 * whose Gateway builds its context, so a client's broadcast takes no `newChain`.
 *
 * **`onResult` is required, and hears only failures.** It is a partial continuation on this node
 * that the framework completes with each failing target's Error, via the standard last-argument
 * convention; every call the loop makes is `onErrorOnly`, so a successful push reports nothing. A
 * push nobody reaps names a handler that logs. For drop-on-failed-broadcast cleanup:
 *
 *   ```ts
 *   onBroadcastResult(resourceId: string, result?: unknown): void {
 *     if (result instanceof Error && result.name === 'ClientDisconnectedError') {
 *       const target = this.lmz.callContext.callee?.instanceName;
 *       if (target) this.#subscriptions.removeSubscriber(resourceId, target);
 *     }
 *   }
 *   ```
 *
 * passed as `onResult: this.ctn<this>().onBroadcastResult(resourceId)`. It needs no `@mesh()`:
 * the Error reaches it locally, or at this node's fire-back door, and neither checks for `@mesh()`.
 *
 * **`callContext.callee` names the failing target wherever the handler runs.** A target that
 * refuses at admission runs the handler on this node's own dispatch, and `callee` is the address
 * the push went to. A DO or Worker that acks and then throws fires its Error back to this node's
 * fire-back door, where `callee` is the fire-back's last hop: the target that threw. A Gateway
 * acks a push to its client and fires a failure back the same way, with the client as last hop.
 * A client's handler comes back through its Gateway and runs under the same last hop, or the
 * target its Gateway dispatched to when that target refused at once.
 *
 * No per-target catch: on a DO or Worker, a target whose binding does not route throws synchronously
 * out of the loop, so a misconfigured address fails loudly at the first one. A client checks no
 * binding itself; its Gateway answers that target with an Error instead.
 *
 * @see `packages/mesh/test/broadcast.test.ts` — each of the above, driven from a DO, a Worker and a client
 */

import type { Continuation, AnyContinuation } from './ocan/index.js';
import type { LmzApi } from './lmz-api.js';
import type { CallOptions } from './types.js';

/** A single broadcast destination — a binding + optional instance name. */
export interface BroadcastTarget {
  bindingName: string;
  /** `undefined` for Worker (service-binding) targets per the mesh DO/Worker routing rule. */
  instanceName?: string;
}

/** Options for `lmz.broadcast(...)`: `newChain` passes through to each target's call. */
export interface BroadcastOptions extends Pick<CallOptions, 'newChain'> {
  /** A partial continuation on this node, completed with each failing target's Error. */
  onResult: AnyContinuation;
}

/** The type of `lmz.broadcast` on every node. */
export type BroadcastFn = LmzApi['broadcast'];

/**
 * The shared body of every node's `lmz.broadcast`, written against the one member it reads:
 * `lmz.call`. Mirrors `callShared` in `lmz-api.ts`.
 *
 * @internal
 */
export function broadcastShared<T>(
  lmz: Pick<LmzApi, 'call'>,
  targets: BroadcastTarget[],
  remote: Continuation<T>,
  options: BroadcastOptions,
): void {
  const { onResult, newChain = true, ...passedThrough } = options;
  // A successful push has nothing to report, and skipping its fire-back spares this node one
  // handler dispatch per target.
  const callOptions: CallOptions = { ...passedThrough, newChain, onErrorOnly: true };
  for (const t of targets) {
    lmz.call(t.bindingName, t.instanceName, remote, onResult, callOptions);
  }
}
