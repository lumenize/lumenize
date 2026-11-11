/**
 * Participant derivation — how a chat message's displayed identity is computed, in one
 * pure, client-safe module, which Studio's render and the tests both consume.
 *
 * **Display derives ONLY from the server-stamped `meta.recordedClaims`** (the claims the write
 * ran under: author from `sub`, and `kind` from whether that subject is the agent) — never from
 * anything in the message VALUE. That is what makes author spoofing impossible: typia is
 * non-strict, so a hostile client can persist `author`/`role`/any excess key at rest, but
 * no derivation here reads the value at all — the forged keys are indistinguishable from
 * other excess-key garbage.
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
