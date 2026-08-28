/**
 * Profile-completion tri-state (src/profile-gate.ts) — pure classification over the
 * store's profile slot, so this needs no running system (live.md's stated-reason
 * carve-out): the inputs are the slot shapes the store can produce, and the full flow
 * (modal shown, non-dismissible, back-fill) is driven live by the
 * `studio-chat-reload` harness scenario's profile-completion limbs.
 *
 * The load-bearing assertions are the LOADING ones: both not-yet-landed shapes — the
 * missing slot AND the `{}` husk the store proxy vivifies on the subscribing read —
 * classify as `'loading'`, never `'prompt'`. Keying the prompt
 * on a naive `!profile.name` collapses loading into prompt and flashes the modal on every
 * login; the settle state self-heals, so only the transient derivation can catch it —
 * and the husk case is not hypothetical: the first cut keyed loading on
 * `slot === undefined` and the live scenario caught the modal flashing after reload.
 */
import { describe, it, expect } from 'vitest';
import { deriveProfileGate } from '../src/profile-gate';

describe('deriveProfileGate', () => {
  it('never passes through prompt before the snapshot lands', () => {
    // The transition a fresh login walks: no slot → vivified husk (the proxy writes {}
    // on the subscribing read) → landed-empty snapshot → named. Asserting the sequence
    // (not the settle) is what reds a !name-keyed collapse.
    const lifecycle = [
      undefined, // slot never touched
      {}, // vivified by the subscribing read; snapshot still outstanding
      { value: {} }, // landed: the empty profile #mintIdentity leaves behind
      { value: { name: 'Jennifer' } }, // owner completed it
    ];
    expect(lifecycle.map(deriveProfileGate)).toEqual(['loading', 'loading', 'prompt', 'done']);
  });

  it('treats an empty-string name as incomplete', () => {
    expect(deriveProfileGate({ value: { name: '' } })).toBe('prompt');
  });
});
