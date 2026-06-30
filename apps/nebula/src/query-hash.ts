/**
 * Shared query-subscription descriptor + the canonical `queryHash` (Child 2).
 *
 * This module is **isomorphic** — imported by BOTH the browser `NebulaClient` and
 * the server-side capability — so the client can compute the `queryHash` LOCALLY
 * and key its handle before firing, which is what lets `subscribeQuery` be **void**
 * (no awaited return across the client WS — the ADR-003 "thinking-forever" trap;
 * D7/B1). Every `handleQueryUpdate(queryHash, …)` push then correlates by it.
 *
 * The hash is **canonical**: logically-equal queries (reordered keys, present-vs-
 * omitted `onPartial`/`orderBy`) MUST collapse to ONE `queryHash` (coalesces the
 * broadcast partition + makes re-subscribe idempotent — M3). We achieve this by
 * hashing a **normalized tuple in fixed field order** (NOT a raw `stringify` of the
 * object, which preserves key insertion order). `onPartial` is **excluded** — it's
 * a per-subscriber push-shape option read at delivery time (D2), so two clients
 * differing only in `onPartial` share one query (one live row, one broadcast group).
 */

import { stringify } from '@lumenize/structured-clone';

/** v1 implements only `'parentChild'`; typed as `string` because this is a PUBLIC
 *  contract seam (D12) — a future `queryType` (e.g. `'mongoLike'`) is additive and
 *  an unknown one must fail closed server-side, not be a compile error for callers
 *  on a newer client. */
export type QueryType = string;

/** Per-push response shape for a subscriber WITH denials (D2). Default `'allow'`. */
export type OnPartial = 'error' | 'allow';

/** v1 accepts only `'validFrom'` (the default); other keys are additive (D15). */
export type OrderBy = 'validFrom';

/**
 * A query subscription request — a single object carrying its `queryType`
 * discriminant + all options (D7/D12). v1 supports exactly: equality on one
 * to-one relationship `field` (`field == value`, `value` = the parent id).
 */
export interface QueryDescriptor {
  queryType: QueryType;
  typeName: string;
  field: string;
  /** The parent id the to-one `field` must equal. */
  value: string;
  /** Per-push shape for a has-denial subscriber (D2); default `'allow'`. NOT hashed. */
  onPartial?: OnPartial;
  /** Result ordering; v1 only `'validFrom'` (default). */
  orderBy?: OrderBy;
}

/** A membership push payload (D4). `resourceIds` = readable ids (ordered); absent on
 *  `onPartial:'error'` with denials. `deniedNodes` = denied node ids (request-access). */
export interface QueryUpdatePayload {
  resourceIds?: string[];
  deniedNodes?: number[];
}

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

/**
 * The canonical `queryHash` for a query — the content key (analogous to
 * `resourceId` for single-resource subs). Hashes a fixed-order tuple of the
 * IDENTITY fields (`queryType`, `typeName`, `field`, `value`, `orderBy` with its
 * default normalized) via the shared isomorphic `stringify` (ADR-002 fidelity) +
 * the sync `fnv1a64`. `onPartial` is deliberately absent (M3). Stable across clients
 * and across re-subscribes.
 */
export function canonicalQueryHash(query: QueryDescriptor): string {
  const tuple = [
    query.queryType,
    query.typeName,
    query.field,
    query.value,
    query.orderBy ?? 'validFrom',
  ];
  return fnv1a64(stringify(tuple));
}
