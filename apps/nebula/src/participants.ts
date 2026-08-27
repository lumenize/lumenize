/**
 * Participant derivation — how a chat message's displayed identity is computed, in one
 * pure, client-safe module (Phase 4's render and the tests both consume it).
 *
 * **Display derives ONLY from the server-stamped `meta.actingToken`** (verified claims:
 * author from `sub`, `kind` from the outermost `act?.sub === NEBULA_SUB`) — never from
 * anything in the message VALUE. That is what makes author spoofing impossible: typia is
 * non-strict, so a hostile client can persist `author`/`role`/any excess key at rest, but
 * no derivation here reads the value at all — the forged keys are indistinguishable from
 * other excess-key garbage.
 *
 * `kind` is DERIVED, never stored: a stored kind would be a second, client-writable
 * source of truth that can contradict the stamp, and deriving means a future agent type
 * needs no data rewrite.
 */

import { NEBULA_SUB } from '@lumenize/nebula-auth/claims';
import type { WireActingToken } from './resources';

/** A message participant's kind — `agent` for a Nebula-actor-stamped message, else `human`. */
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
 * `kind` from the stamp: a message is the AGENT's iff the OUTERMOST `act` entry is the
 * reserved Nebula actor. A constant compare — shape-agnostic, no UUID assumptions.
 */
export function deriveKind(actingToken: Pick<WireActingToken, 'act'>): ParticipantKind {
  return actingToken.act?.sub === NEBULA_SUB ? 'agent' : 'human';
}

/**
 * Every party to a message, BYLINE ORDER — the whole chain top-down (`{actor} for
 * {principal}`), every party deliberately shown: outermost actor first (Nebula on an
 * agent message), any deeper actors next (a coach who was impersonating), the SUBJECT
 * last. A subject-only message yields one entry. The byline renders each entry's name
 * (resolved via its `profileId`) joined with " for " — *Nebula for {coach} for {user}*
 * on the depth-2 record, no parentheses.
 */
export function deriveParticipants(actingToken: WireActingToken): ParticipantRef[] {
  const kind = deriveKind(actingToken);
  const parties: ParticipantRef[] = [];
  for (let a = actingToken.act; a; a = a.act) {
    parties.push({
      sub: a.sub,
      // Only the OUTERMOST reserved actor is the agent; a deeper chain entry is a human
      // actor (the coach) whatever surrounds it.
      kind: a.sub === NEBULA_SUB ? 'agent' : 'human',
      ...(a.profileId ? { profileId: a.profileId } : {}),
    });
  }
  parties.push({
    sub: actingToken.sub,
    // The subject of an agent-actor message is still the human it ran for.
    kind: parties.length === 0 ? kind : 'human',
    ...(actingToken.profileId ? { profileId: actingToken.profileId } : {}),
  });
  return parties;
}
