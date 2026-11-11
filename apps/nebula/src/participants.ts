/**
 * Participant derivation — how a chat message's displayed identity is computed, in one
 * pure, client-safe module, which Studio's render and the tests both consume.
 *
 * **Who wrote a message derives ONLY from the server-stamped `meta.recordedClaims`** (the claims
 * the write ran under: author from `sub`, and `kind` from whether that subject is the agent) —
 * never from anything in the message VALUE. That is what makes author spoofing impossible:
 * typia is non-strict, so a hostile client can persist `author`/`role`/any excess key at rest,
 * and nothing here reads it.
 *
 * A message's value is read in the places that say so, and only on a message whose recorded
 * subject is the agent: {@link toolCallMarks}, {@link waitingPosts} and {@link messageByline}. No client can write
 * such a message, since only the Galaxy's own code runs under the agent's claims, so what its
 * value says is the Galaxy's word and never a person's.
 *
 * `kind` is DERIVED, never stored: a stored kind would be a second, client-writable
 * source of truth that can contradict the stamp, and deriving means a future agent type
 * needs no data rewrite.
 */

import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { WireRecordedClaims } from '@lumenize/resources/client';

/** A message participant's kind: `agent` when the agent wrote the message, else `human`. */
export type ParticipantKind = 'agent' | 'human';

/** One rendered party: the id display resolves through (`store.lmz.profiles[profileId]`). */
export interface ParticipantRef {
  sub: string;
  kind: ParticipantKind;
  /** The party's PUBLIC profile address (ADR-012/013 — display-only, stamped at write time).
   *  Absent only on pre-stamp cold records (pre-alpha degrades to the bare `sub`). */
  profileId?: string;
}

/**
 * `kind` from the stamp: a message is the agent's when its recorded SUBJECT is the agent, which
 * posts as itself and with no `act`. A person's write the agent made for them records the person
 * as subject and the agent as `act`, and is that person's. No client can write the agent as a
 * subject: only the Galaxy's own code runs under the agent's claims.
 */
export function deriveKind(recordedClaims: Pick<WireRecordedClaims, 'sub'>): ParticipantKind {
  return recordedClaims.sub === NEBULA_SUB ? 'agent' : 'human';
}

/**
 * Every party to a record, BYLINE ORDER — the whole chain top-down (`{actor} for
 * {principal}`), every party deliberately shown: the outermost actor first, any deeper actors
 * next (a coach who was impersonating), the SUBJECT last. A subject-only record yields one
 * entry, as an agent message does, and a person's own post. The byline renders each entry's
 * name (resolved via its `profileId`) joined with " for " — *{coach} for {user}* on an
 * impersonated post, no parentheses.
 */
export function deriveParticipants(recordedClaims: WireRecordedClaims): ParticipantRef[] {
  const party = (p: { sub: string; profileId?: string }): ParticipantRef => ({
    sub: p.sub,
    kind: p.sub === NEBULA_SUB ? 'agent' : 'human',
    ...(p.profileId ? { profileId: p.profileId } : {}),
  });
  const parties: ParticipantRef[] = [];
  for (let a = recordedClaims.act; a; a = a.act) parties.push(party(a));
  parties.push(party(recordedClaims));
  return parties;
}

/** What the answered check reads of one message in a thread: its id, who its current snapshot
 *  records as its writer, and the posts its value says it answers. */
export interface ThreadMessage {
  id: string;
  /** The recorded SUBJECT of the message's current snapshot. */
  sub: string;
  answers?: readonly string[];
}

/**
 * The people's posts in `thread` that no agent message has answered, in thread order. This is
 * the one place that decides whether a post is answered, for the Galaxy's decision and for
 * Studio: a post is answered when a message whose recorded subject is the agent names it in
 * `answers`. A person's message naming a post answers nothing, and neither does an agent
 * message a person has since edited, whose current snapshot records that person, so nobody can
 * silence someone else's post. A later agent message that does not name a post leaves it
 * waiting: *Done, Jennifer* follows Austen's post and does not answer it.
 */
export function waitingPosts(thread: readonly ThreadMessage[]): string[] {
  const answered = new Set<string>();
  for (const m of thread) {
    if (m.sub === NEBULA_SUB) for (const id of m.answers ?? []) answered.add(id);
  }
  return thread.filter((m) => m.sub !== NEBULA_SUB && !answered.has(m.id)).map((m) => m.id);
}

/** What Studio marks one tool call with: the post it acted for, and whose claims it ran under,
 *  in byline order, the agent first and the person it acted for last. */
export interface ToolCallMark {
  /** The call's position in the message's `codegen.toolCalls`. */
  index: number;
  name: string;
  post: string;
  parties: ParticipantRef[];
}

/**
 * The marks for an agent message's tool calls, one per call that recorded the claims it ran
 * under. They attest whose authority each call used: the model also says so in its reply, and
 * only this record, which the Galaxy wrote as the call ran, can be relied on.
 *
 * This is the one place display reads a message's VALUE, and only on a message whose recorded
 * subject is the agent. No client can write such a message, since only the Galaxy's own code
 * runs under the agent's claims, so a person's message carrying a forged `codegen.toolCalls`
 * is given none.
 */
export function toolCallMarks(
  recordedClaims: Pick<WireRecordedClaims, 'sub'>,
  value: { codegen?: { toolCalls?: ReadonlyArray<{ name?: string; post?: string; claims?: WireRecordedClaims }> } } | undefined,
): ToolCallMark[] {
  if (recordedClaims.sub !== NEBULA_SUB) return [];
  const marks: ToolCallMark[] = [];
  (value?.codegen?.toolCalls ?? []).forEach((call, index) => {
    if (call.post && call.claims?.sub) marks.push({ index, name: call.name ?? '', post: call.post, parties: deriveParticipants(call.claims) });
  });
  return marks;
}

/** A Message as the client's store holds it, as far as the answered check reads it. */
export type StoredMessage = { value?: { answers?: readonly string[] }; meta?: { recordedClaims?: { sub?: string } } } | undefined;

/**
 * Whether the post `postId` is answered, read from the chat's messages as the store holds them:
 * `ids` in thread order, each looked up with `message`. It is {@link waitingPosts} over what has
 * loaded so far, so a post is answered when an agent message names it in `answers`, whichever
 * post that message replies to. A post whose own snapshot has not loaded yet is not answered.
 */
export function postAnswered(postId: string, ids: readonly string[], message: (id: string) => StoredMessage): boolean {
  const thread: ThreadMessage[] = [];
  for (const id of ids) {
    const stored = message(id);
    const sub = stored?.meta?.recordedClaims?.sub;
    if (sub) thread.push({ id, sub, answers: stored!.value?.answers });
  }
  return thread.some((m) => m.id === postId) && !waitingPosts(thread).includes(postId);
}

/**
 * A message's byline. A person's post reads as its own chain, top-down: *Austen*, or *{coach}
 * for {user}* on an impersonated post. The agent's message reads *Lumenize, re: Austen*, naming
 * the author of each post it answers by that post's own recorded chain, so an answer to an
 * impersonated post reads *Lumenize, re: {coach} for {user}*, and two answered posts read
 * *Lumenize, re: Jennifer and Austen*. An agent message that answers nothing, as a handler's
 * outcome post does, reads *Lumenize*.
 *
 * It says *re:* and not *for*: the message is the agent's own, and only its tool calls ran
 * under a person's claims, which {@link toolCallMarks} shows. `answered` is the recorded
 * claims of each post the message's value names in `answers`, which the caller looks up; it
 * is read only when the message's recorded subject is the agent.
 */
export function messageByline(
  recordedClaims: WireRecordedClaims,
  answered: readonly WireRecordedClaims[],
  nameOf: (party: ParticipantRef) => string,
): string {
  const chain = (claims: WireRecordedClaims): string => deriveParticipants(claims).map(nameOf).join(' for ');
  const own = chain(recordedClaims);
  if (recordedClaims.sub !== NEBULA_SUB) return own;
  const authors = [...new Set(answered.map(chain))];
  if (authors.length === 0) return own;
  const list = authors.length === 1 ? authors[0]! : `${authors.slice(0, -1).join(', ')} and ${authors[authors.length - 1]}`;
  return `${own}, re: ${list}`;
}
