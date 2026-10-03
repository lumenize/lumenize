/**
 * Broadcast — send one continuation to many targets, one `lmz.call` per target, from the node that
 * decided to push.
 *
 * `this.lmz.broadcast(targets, remote, options?)` is a member of every node's `lmz` — a
 * `LumenizeDO`, a `LumenizeWorker`, a `LumenizeClient`, and a node composed with `ComposedMeshDO` —
 * because all it needs is that node's `lmz.call`. The sender a receiver sees is therefore always
 * the node that decided to push, at any N. Its tail latency grows with N; the recursive Worker
 * tier that once cut it was removed, and its measurements are in the 2026-06-06 blog post.
 *
 * **The chain starts fresh by default.** Each target sees a chain that starts at this node and
 * carries no `originAuth`, because a push speaks for the node that sends it, not for whoever's call
 * caused it: a subscriber's page never receives the writer's claims. `newChain: false` makes each
 * target inherit the caller's `callChain` with this node appended, and the caller's `originAuth`,
 * for an app that wants the writer's claims to ride. `state` seeds or merges `callContext.state`
 * as it does on `call`.
 *
 * **`onResult` hears only failures.** It is a partial continuation on this node that the framework
 * completes with each failing target's Error, via the standard last-argument convention; the loop
 * adds `onErrorOnly: true` whenever one is given, so a successful push reports nothing. For
 * drop-on-failed-broadcast cleanup:
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
 * ⚠️ **`callContext.callee` names the failing target only where the handler runs on THIS node's
 * dispatch** — a Gateway target (the Gateway answers a push inside its ack, so a disconnected
 * client's `ClientDisconnectedError` arrives that way) and any target that refused at admission.
 * A DO or Worker that acks and then throws fires its Error back to this node's fire-back door,
 * where `callee` names this node, the broadcaster. Drop-a-dead-subscriber cleanup reads the first
 * case, which is why it works.
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

/** Options for `lmz.broadcast(...)`: `newChain` and `state` pass through to each target's call. */
export interface BroadcastOptions extends Pick<CallOptions, 'newChain' | 'state'> {
  /** A partial continuation on this node, completed with each failing target's Error. */
  onResult?: AnyContinuation;
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
  options: BroadcastOptions = {},
): void {
  const { onResult, newChain = true, ...passedThrough } = options;
  const callOptions: CallOptions = { ...passedThrough, newChain };
  // A successful push has nothing to report, and skipping its fire-back spares this node one
  // handler dispatch per target.
  if (onResult) callOptions.onErrorOnly = true;
  for (const t of targets) {
    lmz.call(t.bindingName, t.instanceName, remote, onResult, callOptions);
  }
}
