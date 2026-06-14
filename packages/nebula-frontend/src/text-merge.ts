/**
 * 3-way LCS text merge — `base` is the common ancestor; `local` and `server`
 * each diverged from it. Returns a merge preserving both sides' non-overlapping
 * edits. `base` is required and load-bearing (deep-review B4): with `base ===
 * server` the result collapses to `local` and silently drops the server edit.
 *
 * Scaffold skeleton. Ported in Phase 5.3.7-v3 from
 * apps/nebula/spike/vue-factory/src/text-merge.ts (factory-textmerge detour),
 * together with `makeLongformResolver` and its 28 property tests.
 *
 * @see https://lumenize.com/docs/nebula/api-reference#textmerge
 */
export function textMerge(_server: string, _local: string, _base: string): string {
  throw new Error(
    'textMerge: not yet ported (nebula-frontend v3 — see tasks/factory-textmerge.md)',
  );
}
