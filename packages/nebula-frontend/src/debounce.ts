/**
 * Per-resource debounce + serial-per-(rt, rid) submission queue.
 *
 * Scaffold skeleton. Ported in Phase 5.3.7-v3 from
 * apps/nebula/spike/vue-factory/src/debounce-queue.ts (debounce-serial-queue
 * detour, Phase D2): quiet/maxWait timers, in-flight buffering, flush-on-
 * (unmount|blur|dispose), connection-gating, eTag-chain + base re-anchor.
 *
 * @see tasks/debounce-serial-queue.md
 */
export function createDebounceQueue(): never {
  throw new Error(
    'debounce queue: not yet ported (nebula-frontend v3 — see tasks/debounce-serial-queue.md)',
  );
}
