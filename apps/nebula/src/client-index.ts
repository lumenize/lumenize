/**
 * @lumenize/nebula/client — Studio's Node.js- and browser-safe surface.
 *
 * `StudioClient` and what Studio's chat reads: the chat constants, participant derivation and the
 * turn-liveness reducer. Everything a generated app's page uses is `@lumenize/resources/client`
 * (or `/frontend`), and the host grammar is `@lumenize/mesh/client`.
 *
 * The main `@lumenize/nebula` entry re-exports `Universe`, `Galaxy`, `Star` and the entrypoint,
 * which transitively import `cloudflare:workers` and fail outside Workers. This file leaves them out.
 */

// Studio's own Client: NebulaClient plus chat posts, picture uploads and the build reply.
export { StudioClient } from './studio-client';
export type { StudioClientConfig } from './studio-client';

// Scope-deletion wire types — re-exported so Studio, which depends on `@lumenize/nebula`, can type
// the confirm screen against the SHARED shape instead of hand-copying it. A hand-copy silently
// rots: `nebula-studio-ui` has no `vue-tsc` and is the sole `SKIP_PACKAGES` entry, so a field
// rename there surfaces only as a runtime TypeError.
export type {
  AffectedScope, ScopeDeletionBlocker, ScopeDeletionAffectedUsers, ScopeDeletionPlan,
} from '@lumenize/mesh/auth';

// Chat identity + the platform chat-ontology version label (pure strings — the value a
// chat client sends as its `ontologyVersion`).
export { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from './chat-constants';

// Participant derivation — display identity from the stamped `meta.actingToken`
// (author from `sub`, kind from the outermost act?.sub === NEBULA_SUB). Pure.
export { deriveKind, deriveParticipants } from './participants';
export {
  startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS, TURN_HEARTBEAT_MS,
  type TurnLiveness, type TurnPhase, type TurnDisplay,
} from './turn-liveness';
export type { ParticipantKind, ParticipantRef } from './participants';
