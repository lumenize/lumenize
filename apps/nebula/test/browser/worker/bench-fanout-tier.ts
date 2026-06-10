/**
 * BenchFanoutTier — minimal LumenizeWorker subclass exported solely to
 * satisfy the `LUMENIZE_BROADCAST_TIER` service binding on the bench
 * worker's `wrangler.jsonc`. All actual broadcast-tier behavior is
 * inherited from `LumenizeWorker` (the `@mesh() __broadcastTier` and
 * `@mesh() __forwardBroadcastResult` methods).
 *
 * In production Nebula a similarly-shaped entrypoint class needs to exist
 * and be bound under the same convention name. See `tasks/fanout-scaling-benchmark.md`
 * for the framework primitive.
 *
 * Pre-broadcast-lift versions of this file carried a custom `fanout`
 * method used by the bench-only `BenchBroadcaster` DO; that path has
 * been superseded by Star calling `this.svc.broadcast(...)` directly,
 * which routes through `__broadcastTier` instead.
 */

import { LumenizeWorker } from '@lumenize/mesh';

export class BenchFanoutTier extends LumenizeWorker<Env> {}
