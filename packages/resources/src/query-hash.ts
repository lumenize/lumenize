/**
 * The query-subscription descriptor and its canonical `queryHash`.
 *
 * This module is **isomorphic**: the browser's `NebulaClient` and the host both import it, so the
 * client computes the `queryHash` itself and keys its handle before it sends anything. That is what
 * lets `subscribeQuery` return nothing across the socket (ADR-003), and every
 * `handleQueryUpdate(queryHash, …)` push then finds its handle by the hash.
 *
 * The hash is **canonical**: two queries that mean the same collapse to one `queryHash`, which is
 * one set of subscribers and one rerun. A filter's keys are sorted before hashing, at every depth,
 * since `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` select the same resources. A list keeps its order.
 */

import { stringify } from '@lumenize/structured-clone';
import type { Filter } from './query/where';

/**
 * A query: the resources of one type that match a filter.
 *
 * `{ typeName: 'Message', filter: { chat: chatId } }` is a chat's Messages. `src/query/where.ts`
 * says what a filter may hold and what each operator means. A query must give one of the type's
 * indexes something to look up, or set `allowScan`, which reads every resource of the type and is
 * right only for a type that will hold a few.
 */
export interface QueryDescriptor {
  typeName: string;
  filter: Filter;
  allowScan?: boolean;
}

/** A membership push payload. `resourceIds` are the ids the subscriber can read, ordered, and at
 *  most {@link QUERY_RESULT_CAP} of them; `more` is set when the query matched more than that.
 *  `deniedNodes` are the nodes holding results it cannot read (ADR-008: told, never silently
 *  dropped), and the request-access UI's input. */
export interface QueryUpdatePayload {
  resourceIds?: string[];
  deniedNodes?: string[];
  more?: true;
}

/** The most results one push carries. Paging past it is not built. */
export const QUERY_RESULT_CAP = 1000;

/** One entry in a query's subscriber-list roster — a distinct PERSON (deduped by `sub`) subscribed to a
 *  query's data, with their public `profileId` display handle, which every token carries. "Presence"
 *  (who's online) is the first use case. */
export interface SubscriberEntry {
  sub: string;
  profileId: string;
}

/** A subscriber-list roster push payload — the DISTINCT-by-`sub` roster of a query's data-subscribers,
 *  delivered on the dedicated `handleQuerySubscribersUpdate` channel to the query's WATCHERS (never folded
 *  into a query-data push). Advisory/display-only; carries no `dominionOverHostAtSubscribe`/permission data (ADR-008). */
export type SubscriberRosterPayload = SubscriberEntry[];

/**
 * FNV-1a, 64-bit variant — the standard algorithm (offset basis
 * `0xcbf29ce484222325`, prime `0x100000001b3`), implemented from its public
 * definition. We implement it rather than use a library because there is **no
 * synchronous hash in the JS standard library or the Workers runtime**:
 * `crypto.subtle.digest` is async (and crypto-grade), which would push the client's
 * local `queryHash` compute off the synchronous register path and break the
 * compute-locally-before-firing design. **Non-crypto by design** — this is a CONTENT
 * KEY, not a secret. 64-bit so an accidental collision (which would wrongly MERGE two
 * distinct queries' subscriber sets) is a non-issue at any realistic per-Star scale.
 * Operates on UTF-16 code units — deterministic and byte-identical client↔server
 * (both JS), which is all a content key requires.
 */
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
function fnv1a64(s: string): string {
  let h = FNV64_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV64_PRIME) & FNV64_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/** `value` with every plain object's keys sorted, at every depth. Lists, Dates and scalars stay. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys((value as Record<string, unknown>)[key]);
  return out;
}

/**
 * The canonical `queryHash` for a query: its content key, as `resourceId` is a single resource's.
 * It hashes the type, the filter with its keys sorted, and whether the scan is allowed, through the
 * shared `stringify` (so a `Date` in a filter hashes as itself) and the synchronous `fnv1a64`.
 * Stable across clients and across re-subscribes.
 */
export function canonicalQueryHash(query: QueryDescriptor): string {
  return fnv1a64(stringify([query.typeName, sortedKeys(query.filter), query.allowScan === true]));
}
