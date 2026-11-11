/**
 * The pure pieces of the agent loop: which posts wait, what an agent message says it answers,
 * and which held call a tool call runs under. Each is a function of its arguments, which is why
 * these need no running system; `held-posts.test.ts` drives them behind real clients, and
 * `held-post-answered` behind real logins and the real model.
 */
import { describe, it, expect } from 'vitest';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { waitingPosts } from '../src/participants';
import {
  agentMessageValue, heldCallFor, renderDecisionRequest, renderHeldBlock, HELD_HEADER,
} from '../src/codegen-loop';

describe('waitingPosts', () => {
  // Mutation: treat a post as answered once any agent message follows it → Austen's post,
  // which "Done, Jennifer" follows and does not name, reads as answered.
  it('leaves Austen\'s post waiting after an agent message that answers only Jennifer\'s', () => {
    const thread = [
      { id: 'j1', sub: 'jennifer' },
      { id: 'a1', sub: 'austen' },
      { id: 'reply', sub: NEBULA_SUB, answers: ['j1'] },
    ];
    expect(waitingPosts(thread)).toEqual(['a1']);
  });

  // Mutation: count `answers` whoever wrote the message → Austen's message answers Jennifer's post.
  it('counts answers only on a message the agent wrote', () => {
    expect(waitingPosts([{ id: 'j1', sub: 'jennifer' }, { id: 'a1', sub: 'austen', answers: ['j1'] }])).toEqual(['j1', 'a1']);
  });

  it('never lists the agent\'s own messages, and one message can answer several posts', () => {
    const thread = [
      { id: 'j1', sub: 'jennifer' }, { id: 'a1', sub: 'austen' },
      { id: 'both', sub: NEBULA_SUB, answers: ['j1', 'a1'] }, { id: 'outcome', sub: NEBULA_SUB },
    ];
    expect(waitingPosts(thread)).toEqual([]);
  });
});

describe('agentMessageValue', () => {
  // Mutation: build `answers` from the named posts alone → the post the turn took up is missing,
  // so a turn's own post would wait for ever.
  it('always puts the post the turn took up among the posts it answers, each once', () => {
    expect(agentMessageValue({ chat: 'c', content: 'done', replyTo: 'j1' })).toEqual({
      chat: 'c', content: 'done', status: 'complete', replyTo: 'j1', answers: ['j1'],
    });
    expect(agentMessageValue({ chat: 'c', content: 'done', replyTo: 'j1', answers: ['a1', 'j1'] }).answers).toEqual(['j1', 'a1']);
  });

  it('carries neither field on a message that answers nothing, as a handler\'s outcome post', () => {
    const value = agentMessageValue({ chat: 'c', content: 'the invite was sent' });
    expect('replyTo' in value).toBe(false);
    expect('answers' in value).toBe(false);
  });
});

describe('heldCallFor', () => {
  const held = new Map([['j1', 'jennifer\'s call'], ['a1', 'austen\'s call']]);

  // Mutation: validate the named post and then use the turn's own → the first line answers Austen's.
  it('answers the named post\'s call, or the call of the post the turn took up', () => {
    expect(heldCallFor(held, 'a1', 'j1')).toBe('jennifer\'s call');
    expect(heldCallFor(held, 'a1')).toBe('austen\'s call');
  });

  // Mutation: skip the check and answer whatever the map holds → `undefined` comes back and the
  // call would run under nobody.
  it('throws, naming the post, when the post is not held', () => {
    expect(() => heldCallFor(held, 'a1', 'gone')).toThrow('post gone is not held, so nothing can run under its poster\'s claims');
    expect(() => heldCallFor(held, 'gone')).toThrow('post gone is not held');
    expect(() => heldCallFor(held, undefined)).toThrow('no post is taken up');
  });
});

describe('what the prompt says about held and waiting posts', () => {
  it('lists each held post with whose claims they are, and says so when nothing is held', () => {
    expect(renderHeldBlock([{ postId: 'j1', speaker: 'human 1', admin: true }, { postId: 'a1', speaker: 'human 2', admin: false }]))
      .toBe(`${HELD_HEADER}\n- post j1: human 1, an admin\n- post a1: human 2`);
    expect(renderHeldBlock([])).toBe(`${HELD_HEADER}\n- none. You can read, answer and ask, and no tool that acts is offered.`);
  });

  it('a decision\'s request lists the waiting posts, each held or not', () => {
    const request = renderDecisionRequest([
      { postId: 'j1', speaker: 'human 1', held: false, content: 'build a wishlist' },
      { postId: 'a1', speaker: 'human 2', held: true, content: 'hello?' },
    ]);
    expect(request).toContain('- post j1 (human 1, not held): build a wishlist\n- post a1 (human 2, held): hello?');
  });
});
