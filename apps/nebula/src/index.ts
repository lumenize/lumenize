/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { NebulaDO, requireDominionHere, requirePassage } from './nebula-do';
export { Universe } from './universe';
export { Galaxy, requireChatWrite, assertModelPath, LOOP_TOOL_ENTRIES } from './galaxy';
export { Star } from './star';
// The session entry, with the hooks that wipe this Worker's Durable Objects on a deletion or creation.
export { NebulaAuthFacade } from './nebula-auth-facade';

// The platform chat ontology: pure strings from the client-safe leaf; the compiled
// seed row from the server-only module.
export {
  DEFAULT_CHAT_ID,
  CHAT_NODE_ID,
  CHAT_MESSAGE_ONTOLOGY_VERSION,
  CHAT_MESSAGE_TYPES,
} from './chat-constants';
export { chatOntologySeedRow } from './chat-ontology';
// Participant derivation — display identity from the stamped actingToken (client-safe).
export { deriveKind, deriveParticipants } from './participants';
export {
  startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS, TURN_HEARTBEAT_MS,
  type TurnLiveness, type TurnPhase, type TurnDisplay,
} from './turn-liveness';
export type { ParticipantKind, ParticipantRef } from './participants';

// Studio's own Client — a generated app's `NebulaClient` is `@lumenize/resources`'s.
export { StudioClient } from './studio-client';
export type { StudioClientConfig } from './studio-client';

// Entrypoint
export { default as entrypoint } from './entrypoint';
// The platform host's own routes — every Worker that runs the entrypoint binds it as `PLATFORM_HOST`.
export { PlatformHost } from './platform-host';
