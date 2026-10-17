/**
 * 3-way text merge (LCS-based) for long-form text fields. Doc-as-spec:
 * `website/docs/nebula/api-reference.md` § textMerge. Hand-rolled (no
 * diff-match-patch dependency) per the factory-textmerge detour's build-vs-borrow.
 *
 * Merge granularity is word-level: inputs are tokenized into alternating runs
 * of whitespace / non-whitespace (so `tokens.join('') === input` exactly),
 * then aligned diff3-style via two LCS passes (base↔local, base↔server).
 * Base tokens matched on BOTH sides are anchors; each gap between anchors is
 * resolved per side.
 */

/**
 * `base` is the common ancestor both `local` and `server` diverged from, and
 * it is load-bearing (deep-review B4): passing `base === server` makes the
 * server→base diff empty and the result collapses to `local`, silently
 * dropping the concurrent server edit. Callers must pass
 * `resolution.base.value.<field>`, never the server snapshot.
 *
 * Identity rules (exact, short-circuited): `local === server` ⇒ that value;
 * `server === base` ⇒ `local`; `local === base` ⇒ `server`.
 *
 * Overlap policy (the documented garble — see api-reference § textMerge
 * Limitations): when both sides edit the same span, the span resolves to the
 * LOCAL side wholesale, except a pure local deletion (empty local side) never
 * erases a non-empty server edit — the server side wins that span. Net
 * guarantee: the result is `''` only when `local === server === ''` or an
 * identity rule mandates it; concurrent non-overlapping edits both survive.
 *
 * Pure and deterministic: no clock, no randomness, same inputs ⇒ same output.
 * Cost: common prefix/suffix trim + O(n·m) LCS on the divergent middle; pairs
 * whose middle exceeds {@link MAX_DP_CELLS} degrade to "whole middle is one
 * conflict span" (still deterministic, never a crash).
 */
export function textMerge(server: string, local: string, base: string): string {
  if (local === server) return local;
  if (server === base) return local;
  if (local === base) return server;

  const baseT = tokenize(base);
  const localT = tokenize(local);
  const serverT = tokenize(server);
  const matchLocal = lcsMatches(baseT, localT);
  const matchServer = lcsMatches(baseT, serverT);

  const out: string[] = [];
  let bPrev = 0;
  let lPrev = 0;
  let sPrev = 0;

  const flushGap = (bEnd: number, lEnd: number, sEnd: number): void => {
    const baseChunk = baseT.slice(bPrev, bEnd).join('');
    const localChunk = localT.slice(lPrev, lEnd).join('');
    const serverChunk = serverT.slice(sPrev, sEnd).join('');
    if (localChunk === baseChunk) {
      out.push(serverChunk); // only server changed (or neither)
    } else if (serverChunk === baseChunk) {
      out.push(localChunk); // only local changed
    } else if (localChunk === serverChunk) {
      out.push(localChunk); // both made the identical change
    } else if (localChunk === '' && serverChunk !== '') {
      out.push(serverChunk); // local deletion never erases a server edit
    } else {
      out.push(localChunk); // overlap garble: local wins the span
    }
  };

  for (let i = 0; i < baseT.length; i++) {
    const li = matchLocal.get(i);
    const si = matchServer.get(i);
    if (li === undefined || si === undefined) continue;
    flushGap(i, li, si);
    out.push(baseT[i]!);
    bPrev = i + 1;
    lPrev = li + 1;
    sPrev = si + 1;
  }
  flushGap(baseT.length, localT.length, serverT.length);
  return out.join('');
}

/** Alternating runs of whitespace / non-whitespace; `join('')` reconstructs the input. */
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/** DP-table size cap (cells) before degrading to the coarse single-conflict-span merge. */
const MAX_DP_CELLS = 4_000_000;

/**
 * LCS alignment of `a` and `b` as a monotonic baseIndex→otherIndex map of
 * equal-token pairs. Common prefix/suffix are matched outright; the divergent
 * middle goes through O(n·m) DP (or is left unmatched past {@link MAX_DP_CELLS},
 * which downstream treats as one conflict span). Ties in the backtrack break
 * deterministically.
 */
function lcsMatches(a: string[], b: string[]): Map<number, number> {
  const matches = new Map<number, number>();
  const maxPrefix = Math.min(a.length, b.length);
  let p = 0;
  while (p < maxPrefix && a[p] === b[p]) {
    matches.set(p, p);
    p++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > p && endB > p && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) matches.set(i, j);

  const n = endA - p;
  const m = endB - p;
  if (n === 0 || m === 0) return matches;
  if ((n + 1) * (m + 1) > MAX_DP_CELLS) return matches;

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] =
        a[p + i - 1] === b[p + j - 1]
          ? dp[(i - 1) * w + (j - 1)]! + 1
          : Math.max(dp[(i - 1) * w + j]!, dp[i * w + (j - 1)]!);
    }
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[p + i - 1] === b[p + j - 1]) {
      matches.set(p + i - 1, p + j - 1);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j]! >= dp[i * w + (j - 1)]!) {
      i--;
    } else {
      j--;
    }
  }
  return matches;
}

// ──────────────────────────────────────────────────────────────────────────
// `@longform` auto-resolver shape. The annotation→resolver compile pass lives
// in the ontology pipeline; this file owns the merge function + this resolver
// shape (factory-textmerge detour § Auto-registration). `ConflictResolverVerdict`
// is canonical HERE — the conflict-outcome engine imports it from this module
// (text-merge is the lower layer; importing it here would cycle). The local
// `ConflictPendingResolution` is a minimal structural slice of the engine's full
// `'conflict-pending'` branch (which carries `local`/`server`/`base`/`context`);
// `makeLongformResolver` reads only `.{local,server,base}.value`, so it accepts
// the full resolution at runtime.
// ──────────────────────────────────────────────────────────────────────────

/** Minimal structural slice of `TransactionResourceResolution`'s non-terminal branch. */
export interface ConflictPendingResolution {
  kind: 'conflict-pending';
  local: { value: unknown };
  server: { value: unknown };
  base: { value: unknown };
}

/** What a resolver returns for `'conflict-pending'` (api-reference § ConflictResolverVerdict). */
export type ConflictResolverVerdict =
  | { kind: 'use-server' }
  | { kind: 'use-this'; value: unknown }
  | { kind: 'human-in-the-loop' };

/**
 * Per-type resolver a `@longform`-annotated `field` auto-registers: on
 * `'conflict-pending'` it returns `'use-this'` with the server's value plus
 * the 3-way-merged text for `field`; any other resolution kind returns
 * `undefined` (fall through the handler chain, M9). A non-string field value
 * merges as `''` — ontology compilation guarantees `@longform` fields are
 * strings, so that case only arises on never-set optional fields.
 */
export function makeLongformResolver(
  field: string,
): (resolution: { kind: string; [key: string]: unknown }) => ConflictResolverVerdict | undefined {
  const text = (snapshotValue: unknown): string => {
    const v = (snapshotValue as Record<string, unknown> | null | undefined)?.[field];
    return typeof v === 'string' ? v : '';
  };
  return (resolution) => {
    if (resolution.kind !== 'conflict-pending') return undefined;
    const { local, server, base } = resolution as unknown as ConflictPendingResolution;
    return {
      kind: 'use-this',
      value: {
        ...(server.value as Record<string, unknown>),
        [field]: textMerge(text(server.value), text(local.value), text(base.value)),
      },
    };
  };
}
