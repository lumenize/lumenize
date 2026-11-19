/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { Universe } from './universe';
export { Galaxy, requireChatFloor, assertModelPath, LOOP_TOOL_ENTRIES } from './galaxy';
export type { MessageSnapshot } from './chat-constants';
export { Star } from './star';
// The session entry, with the hooks that wipe this Worker's Durable Objects on a deletion or creation.
export { NebulaAuthFacade } from './nebula-auth-facade';

// The platform chat ontology: pure strings from the client-safe leaf; the compiled
// seed row from the server-only module.
export {
  DEFAULT_CHAT_ID,
  CHAT_NODE_ID,
  MESSAGES_NODE_ID,
  TURNS_NODE_ID,
  CHAT_MESSAGE_ONTOLOGY_VERSION,
  CHAT_MESSAGE_TYPES,
} from './chat-constants';
export { chatOntologySeedRow } from './chat-ontology';
// Participant derivation — display identity from the stamped recordedClaims (client-safe).
export { deriveKind, deriveParticipants, waitingPosts, toolCallMarks, roundsOf, turnCalls, postAnswered, messageByline } from './participants';
export type { ThreadMessage, ToolCallMark, TurnCall, StoredMessage } from './participants';
export {
  startTurn, signalTurn, signalOtherTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS, TURN_HEARTBEAT_MS,
  previewLocked, stepLine, pendingLine, streamSteps, formatElapsed, STEP_MARK, PENDING_MARK,
  type TurnLiveness, type TurnPhase, type TurnDisplay,
} from './turn-liveness';
export {
  decidePreviewFrame, LANDING_ECHO_MS, BUTTON_ECHO_MS, LOAD_SILENCE_MS,
  type PreviewFrameState, type PreviewFrameEvent, type PreviewFrameAction, type PendingRequest,
} from './preview-frame';
// The cast an app's `docs/personas.md` names, and how Studio carries a run request to a tab.
export { parseCast, type CastEntry } from './cast';
export { TabRunner, ME_TAB, TAB_RUN_BOUND_MS, NO_SESSION_RETRY_MS, type TabPort, type TabMessage } from './tab-runner';
export type { ParticipantKind, ParticipantRef } from './participants';

// Studio's own Client — a generated app's `NebulaClient` is `@lumenize/resources`'s.
export { StudioClient } from './studio-client';
export type { StudioClientConfig } from './studio-client';

// Entrypoint
export { default as entrypoint } from './entrypoint';
// The platform host's own routes — every Worker that runs the entrypoint binds it as `PLATFORM_HOST`.
export { PlatformHost } from './platform-host';
