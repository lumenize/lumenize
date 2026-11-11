/**
 * Whether my post is answered, read from the chat's messages as Studio's store holds them
 * (`postAnswered` in `src/participants.ts`, which `App.vue`'s `replyLanded` is one call to).
 *
 * The snapshots are seeded here in the shape the store keeps them, `{ value, meta }` by id, which
 * is why this needs no running system: the decision is a function of what has loaded.
 * `held-post-answered` drives the same check in a real Studio page, where a post the agent
 * answered without replying to it stops showing as waiting.
 */
import { describe, it, expect } from 'vitest';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { postAnswered } from '../../src/participants';
import type { StoredMessage } from '../../src/participants';

const person = (sub: string, value: Record<string, unknown> = {}): StoredMessage => ({ value, meta: { recordedClaims: { sub } } });
const agent = (value: Record<string, unknown>): StoredMessage => ({ value, meta: { recordedClaims: { sub: NEBULA_SUB } } });
const lookup = (store: Record<string, StoredMessage>) => (id: string): StoredMessage => store[id];

describe('postAnswered, over the store\'s snapshots', () => {
  // Mutation: decide by `replyTo`, as Studio once did → Austen's post, which the message names
  // without replying to it, never reads as answered.
  it('a post named only in answers, by a message that replies to another post, is answered', () => {
    const store = {
      j1: person('jennifer'), a1: person('austen'),
      reply: agent({ replyTo: 'j1', answers: ['j1', 'a1'] }),
    };
    expect(postAnswered('a1', ['j1', 'a1', 'reply'], lookup(store))).toBe(true);
    expect(postAnswered('j1', ['j1', 'a1', 'reply'], lookup(store))).toBe(true);
  });

  it('a post a later agent message does not name still waits', () => {
    const store = { j1: person('jennifer'), a1: person('austen'), reply: agent({ replyTo: 'j1', answers: ['j1'] }) };
    expect(postAnswered('a1', ['j1', 'a1', 'reply'], lookup(store))).toBe(false);
  });

  // Mutation: count `answers` whoever wrote the message → Jennifer's own message answers Austen's post.
  it('a person\'s message naming it does not answer it', () => {
    const store = { a1: person('austen'), j2: person('jennifer', { answers: ['a1'] }) };
    expect(postAnswered('a1', ['a1', 'j2'], lookup(store))).toBe(false);
  });

  it('a post whose own snapshot has not loaded yet is not answered', () => {
    expect(postAnswered('a1', ['a1', 'reply'], lookup({ reply: agent({ answers: ['a1'] }) }))).toBe(false);
  });
});
