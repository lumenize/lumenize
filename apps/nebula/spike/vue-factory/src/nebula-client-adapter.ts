/**
 * Adapter: NebulaClient → ClientLike (the simple shape the factory consumes).
 *
 * The factory's `ClientLike` shape was designed for the Phase 0a mock-driven
 * tests — a simple "transaction takes one resource, returns one outcome"
 * surface. The real NebulaClient takes an ops batch and returns a richer
 * `TransactionResolution`. This adapter bridges the two so the same factory
 * works against either.
 *
 * Phase -1 item: post-spike, consolidate the factory's ClientLike with
 * NebulaClient's natural API into one shape. The adapter is a temporary
 * scaffold for the spike.
 */
import type { NebulaClient } from './nebula-client';
import type { ClientLike, TransactionOutcome } from './types';
import type { Snapshot } from '@lumenize/nebula/client';

export function adaptNebulaClient(client: NebulaClient): ClientLike {
  let resourceUpdateHandler:
    | ((rt: string, rid: string, snapshot: { value: unknown; meta: { eTag: string } } | null) => void)
    | null = null;

  // Bridge NebulaClient's resource-update events into the factory's
  // ClientLike shape. Error variants are dropped here — the factory's
  // contract is success-only. (Production would surface to a user hook.)
  client.onResourceUpdate((rt, rid, snapshot) => {
    if (snapshot instanceof Error) return;
    if (snapshot === null) {
      resourceUpdateHandler?.(rt, rid, null);
    } else {
      resourceUpdateHandler?.(rt, rid, {
        value: snapshot.value,
        meta: { eTag: snapshot.meta.eTag },
      });
    }
  });

  return {
    async transaction(args): Promise<TransactionOutcome> {
      const { rt, rid, eTag, value, newETag } = args;
      const outcome = await client.resources.transaction(
        { [rid]: { op: 'put', eTag, value } },
        { newETag },
      );

      // Map NebulaClient's rich TransactionResolution → factory's simple TransactionOutcome
      switch (outcome.resolution) {
        case 'committed':
          return { resolution: 'committed', eTag: outcome.eTag };
        case 'use-server': {
          const snap = outcome.resources[rid] as Snapshot | undefined;
          if (!snap) {
            // Conflict resolved but no snapshot for this rid? Treat as committed-server-noop
            return { resolution: 'use-server', snapshot: { value: undefined, meta: { eTag: '' } } };
          }
          return {
            resolution: 'use-server',
            snapshot: { value: snap.value, meta: { eTag: snap.meta.eTag } },
          };
        }
        case 'validation-failed':
          return { resolution: 'validation-failed', errors: outcome.errors };
        case 'permission-denied':
        case 'retries-exhausted':
        case 'human-in-the-loop':
        case 'ontology-stale':
          // Spike: collapse these into validation-failed for rollback purposes.
          // Production would expose each as a distinct rollback path.
          return { resolution: 'validation-failed', errors: { _: outcome } };
        case 'timeout':
          return { resolution: 'timeout' };
      }
    },

    async subscribe(rt, rid) {
      const snap = await client.resources.subscribe(rt, rid);
      if (snap === null) return null;
      return { value: snap.value, meta: { eTag: snap.meta.eTag } };
    },

    unsubscribe(rt, rid): void {
      client.resources.unsubscribe(rt, rid);
    },

    onResourceUpdate(handler) {
      resourceUpdateHandler = handler;
    },

    onConnectionStateChange(handler) {
      client.onConnectionStateChange(handler as (s: any) => void);
    },
  };
}
