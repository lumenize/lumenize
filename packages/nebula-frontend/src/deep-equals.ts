/**
 * Structural deep equality, cycle/alias-safe (ADR-002 — cycles must work).
 *
 * Scaffold skeleton. Ported in Phase 5.3.7-v3 from
 * apps/nebula/spike/vue-factory/src/deep-equals.ts (factory-textmerge detour) —
 * the pair-memo cycle guard + Map/Set/Date handling carry over with it.
 */
export function deepEquals(_a: unknown, _b: unknown): boolean {
  throw new Error(
    'deepEquals: not yet ported (nebula-frontend v3 — see tasks/factory-textmerge.md)',
  );
}
