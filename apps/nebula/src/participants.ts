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
 * subject is the agent: {@link waitingPosts} and {@link messageByline}. {@link toolCallMarks}
 * reads a round's value on the same terms. No client can write as the agent, since only the
 * Galaxy's own code runs under the agent's claims, so what such a value says is the Galaxy's word
 * and never a person's.
 *
 * `kind` is DERIVED, never stored: a stored kind would be a second, client-writable
 * source of truth that can contradict the stamp, and deriving means a future agent type
 * needs no data rewrite.
 */

import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { WireRecordedClaims } from '@lumenize/resources/client';
import type { MessageSnapshot } from './chat-constants';

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

/** What Studio marks one tool call with: the id of the person's message it acted for, and whose
 *  claims it ran under, in byline order, the agent first and the person it acted for last. */
export interface ToolCallMark {
  /** Where the call sits in its turn, `{round}.{call}`: `3.0` is round 3's first call. */
  index: string;
  name: string;
  message: string;
  parties: ParticipantRef[];
}

/**
 * The query that reads one agent message's rounds: `Round where message == id`. Studio's marks
 * and every other reader of a turn's calls ask it, and it is built only here.
 */
export function roundsOf(messageId: string): { typeName: 'Round'; filter: { message: string } } {
  return { typeName: 'Round', filter: { message: messageId } };
}

/** One call of a turn, read from its round: where it sits, what the model asked for, and what
 *  it came to. `messageSnapshot`, `claims`, `result` and `error` are absent on a call that never ran. */
export interface TurnCall {
  /** Its round's index, from 1. */
  round: number;
  /** Its place in the round, from 0. */
  call: number;
  name: string;
  /** The arguments the model wrote, parsed, or the text itself when it did not parse. */
  args: unknown;
  result?: unknown;
  error?: string;
  messageSnapshot?: MessageSnapshot;
  claims?: WireRecordedClaims;
}

/** A round as a query answers it: its value and who wrote it. */
type RoundSnapshot = { value: unknown; meta: { recordedClaims: Pick<WireRecordedClaims, 'sub'> } };
type StoredCallValue = { raw?: { function?: { name?: string; arguments?: string } }; messageSnapshot?: MessageSnapshot; claims?: WireRecordedClaims; result?: unknown; error?: string };

/** Every call of a turn, in order, from its rounds as a query answers them. Reads any round's
 *  value: a reader that attests only what the agent wrote filters first, as {@link toolCallMarks} does. */
export function turnCalls(rounds: ReadonlyArray<RoundSnapshot>): TurnCall[] {
  const values = rounds.map((r) => r.value as { index?: number; calls?: StoredCallValue[] })
    .filter((v) => typeof v?.index === 'number' && Array.isArray(v.calls))
    .sort((a, b) => a.index! - b.index!);
  const out: TurnCall[] = [];
  for (const round of values) {
    round.calls!.forEach((c, call) => {
      const text = c.raw?.function?.arguments;
      let args: unknown = text;
      try { args = text === undefined ? undefined : JSON.parse(text); } catch { /* the text stands */ }
      out.push({
        round: round.index!, call, name: c.raw?.function?.name ?? '', args,
        ...(c.result !== undefined ? { result: c.result } : {}),
        ...(c.error !== undefined ? { error: c.error } : {}),
        ...(c.messageSnapshot !== undefined ? { messageSnapshot: c.messageSnapshot } : {}),
        ...(c.claims !== undefined ? { claims: c.claims } : {}),
      });
    });
  }
  return out;
}

/**
 * The marks for an agent message's tool calls, read from that turn's rounds, one per call that
 * recorded the claims it ran under. They attest whose authority each call used: the model also
 * says so in its reply, and only this record, which the Galaxy wrote as the call ran, can be
 * relied on.
 *
 * Only a round whose current snapshot the agent wrote is read. A round an app admin wrote over is
 * given no marks, since what it says is no longer the Galaxy's word.
 */
export function toolCallMarks(rounds: ReadonlyArray<RoundSnapshot>): ToolCallMark[] {
  const marks: ToolCallMark[] = [];
  for (const c of turnCalls(rounds.filter((r) => r.meta.recordedClaims.sub === NEBULA_SUB))) {
    if (c.messageSnapshot && c.claims?.sub) marks.push({ index: `${c.round}.${c.call}`, name: c.name, message: c.messageSnapshot.id, parties: deriveParticipants(c.claims) });
  }
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
  // One entry per person, by `sub`: two people who share a display name are both named.
  const people = new Map(answered.map((claims) => [deriveParticipants(claims).map((p) => p.sub).join(' '), chain(claims)]));
  const authors = [...people.values()];
  if (authors.length === 0) return own;
  const list = authors.length === 1 ? authors[0]! : `${authors.slice(0, -1).join(', ')} and ${authors[authors.length - 1]}`;
  return `${own}, re: ${list}`;
}
