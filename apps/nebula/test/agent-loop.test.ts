/**
 * The pure pieces of the agent loop: which posts wait, what an agent message says it answers,
 * and which held call a tool call runs under. Each is a function of its arguments, which is why
 * these need no running system; `held-posts.test.ts` drives them behind real clients, and
 * `held-post-answered` behind real logins and the real model.
 */
import { describe, it, expect } from 'vitest';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { messageByline, toolCallMarks, waitingPosts } from '../src/participants';
import type { ParticipantRef } from '../src/participants';
import { CODEGEN_TOOLS, unknownToolArgKeys } from '../src/codegen-loop';
import type { LoopToolDeps } from '../src/codegen-loop';
import {
  agentMessageValue, heldCallFor, renderClosingRequest, renderDecisionRequest, renderHeldBlock, HELD_HEADER,
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

  it('a closing step\'s request lists the posts that arrived, and says the step offers no tool that acts', () => {
    const request = renderClosingRequest([{ postId: 'a1', speaker: 'human 2', content: 'sort by name instead' }]);
    expect(request).toContain('While you worked, these posts arrived, oldest first:\n- post a1 (human 2): sort by name instead\n');
    expect(request).toContain('No tool that acts is offered in this step.');
  });
});

describe('toolCallMarks', () => {
  const AGENT = { sub: NEBULA_SUB, profileId: NEBULA_SUB };
  const value = { codegen: { toolCalls: [
    { name: 'read_file', post: 'j1', claims: { sub: 'jennifer', profileId: 'p-jennifer', act: AGENT } },
    { name: 'mark_complete' },
    { name: 'write_file', post: 'a1', claims: { sub: 'austen', profileId: 'p-austen', act: AGENT } },
  ] } };

  // Mutation: build each mark from the message's own record → every mark names the agent alone.
  it('marks each tool call that recorded its claims, the agent first and the person it acted for last', () => {
    expect(toolCallMarks(AGENT, value).map((m) => [m.index, m.name, m.post, m.parties.map((p) => p.sub)])).toEqual([
      [0, 'read_file', 'j1', [NEBULA_SUB, 'jennifer']],
      [2, 'write_file', 'a1', [NEBULA_SUB, 'austen']],
    ]);
  });

  // Mutation: read the value whoever wrote the message → a person's forged record is marked.
  it('marks nothing on a message a person wrote, whatever its value carries', () => {
    expect(toolCallMarks({ sub: 'austen' }, value)).toEqual([]);
  });
});

describe('messageByline', () => {
  const AGENT = { sub: NEBULA_SUB, profileId: NEBULA_SUB };
  const names: Record<string, string> = { [NEBULA_SUB]: 'Lumenize', jennifer: 'Jennifer', austen: 'Austen', coach: 'Coach', user: 'Dana' };
  const nameOf = (p: ParticipantRef): string => names[p.sub]!;
  const jennifer = { sub: 'jennifer', profileId: 'p-j' };
  const austen = { sub: 'austen', profileId: 'p-a' };
  const impersonated = { sub: 'user', profileId: 'p-u', act: { sub: 'coach', profileId: 'p-c' } };

  // Mutation: build the byline from the agent message's own record alone → every line reads
  // `Lumenize`.
  it('names the author of each post an agent message answers', () => {
    expect(messageByline(AGENT, [austen], nameOf)).toBe('Lumenize, re: Austen');
    expect(messageByline(AGENT, [jennifer, austen], nameOf)).toBe('Lumenize, re: Jennifer and Austen');
    expect(messageByline(AGENT, [impersonated], nameOf)).toBe('Lumenize, re: Coach for Dana');
    // Two posts by one person name them once.
    expect(messageByline(AGENT, [jennifer, jennifer], nameOf)).toBe('Lumenize, re: Jennifer');
    // Two people who share a display name are two people. Mutation: de-duplicate by the
    // rendered name → this reads `Lumenize, re: Sam`.
    const sam = (p: ParticipantRef): string => (p.sub === NEBULA_SUB ? 'Lumenize' : 'Sam');
    expect(messageByline(AGENT, [jennifer, austen], sam)).toBe('Lumenize, re: Sam and Sam');
  });

  it('reads Lumenize alone on a message that answers nothing', () => {
    expect(messageByline(AGENT, [], nameOf)).toBe('Lumenize');
  });

  // Mutation: read `answered` whoever wrote the message → Austen's post is bylined as a reply.
  it('reads a person\'s post as its own chain, whatever its value names', () => {
    expect(messageByline(austen, [jennifer], nameOf)).toBe('Austen');
    expect(messageByline(impersonated, [], nameOf)).toBe('Coach for Dana');
  });
});

describe('the invite tool names no post', () => {
  // Mutation: give `invite` the `postId` every other loop tool takes → the declared keys gain it,
  // the stray key is no longer refused, and the type check below stops erroring. An invite
  // changes who can do what, so whose claims it uses follows from the post its turn took up and
  // from nothing the model sends.
  it('declares an email and an optional scopeAdmin, and refuses a postId by name', () => {
    const invite = CODEGEN_TOOLS.find((tool) => tool.function.name === 'invite')!;
    expect(Object.keys(invite.function.parameters.properties).sort()).toEqual(['email', 'scopeAdmin']);
    expect((invite.function.parameters as { required?: readonly string[] }).required).toEqual(['email']);
    expect(unknownToolArgKeys('invite', { email: 'a@example.com', postId: 'j1' })).toEqual(['postId']);
  });

  it('the dep the loop calls takes no post either', () => {
    const invite: LoopToolDeps['invite'] = async (email) => ({ invited: email, as: 'collaborator', note: '' });
    // @ts-expect-error an invite takes an email and a bit, and no post to run under
    void invite('a@example.com', false, 'j1');
    expect(invite.length).toBe(1);
  });
});
