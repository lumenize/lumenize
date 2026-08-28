/**
 * Profile-completion gating — the tri-state a completion prompt keys on, in one pure,
 * client-safe module (Studio's blocking modal and the tests both consume it).
 *
 * The three values are load-bearing (empty ≠ not-yet-loaded), and the loaded signal is
 * the `value` KEY, not the slot's existence: the store proxy VIVIFIES
 * `store.lmz.profiles[id]` to `{}` on the very read that opens the subscription
 * (create-nebula-client.ts § Vivification), so a keyed-but-valueless slot means the
 * snapshot is still outstanding — the factory's mirror writes `value` on every push,
 * empty profile included. A naive `!name` check reads both not-yet-landed shapes as
 * "incomplete" and flashes the prompt open-then-shut on every login. The prompt keys on
 * `'prompt'` ONLY; a gate that never passes through `'prompt'` before `value` lands is
 * the invariant the tri-state exists to hold. (Caught live: the first cut keyed loading
 * on `slot === undefined` and the vivified husk flashed the modal after every reload.)
 */

/** The slot shape `store.lmz.profiles[profileId]` holds; `value` present ⇔ snapshot landed. */
export interface ProfileSlot {
  value?: { name?: string };
}

export type ProfileGate = 'loading' | 'prompt' | 'done';

export function deriveProfileGate(slot: ProfileSlot | undefined): ProfileGate {
  if (slot?.value === undefined) return 'loading';
  return slot.value.name ? 'done' : 'prompt';
}
