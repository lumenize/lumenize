/**
 * How Studio keeps its preview frame on the build `.dev` serves (ADR-024's build version). Studio
 * asks the frame to reload, naming the build, and the frame decides; Studio sets the frame's
 * address only when it hears no client there, since setting it loses the frame's URL (ADR-017).
 * Pure, so a table pins every arm, and the order of the arms lives here rather than in a
 * template or a chain of listeners (calibration §12).
 *
 * Every event Studio sees goes through {@link decidePreviewFrame}; App.vue only posts, arms the
 * timers the result asks for, and sets the address.
 */

/** A request Studio posted and the frame has not answered. `build` is absent for the Reload
 *  button, which the frame obeys whatever it runs. */
export interface PendingRequest {
  id: string;
  build?: string;
  kind: 'landing' | 'button';
}

export interface PreviewFrameState {
  /** The newest `.dev` build Studio has heard of, from its `ServedBuild` subscription. */
  build?: string;
  /** The request awaiting the frame's echo, if any. */
  pending?: PendingRequest;
  /** The build Studio already resent its request for on an unsolicited `loaded`, so a frame that
   *  reloads itself is asked at most once more per build. */
  resentFor?: string;
  /** When the last unsolicited `loaded` arrived, so a silent `load` can be told from one with a
   *  client, whichever of the two the browser delivers first. */
  lastLoadedAt?: number;
}

export type PreviewFrameEvent =
  /** The `ServedBuild` subscription delivered a value, the first one and a restored one included. */
  | { type: 'value'; build: string; id: string }
  /** The Reload button. */
  | { type: 'button'; id: string }
  /** The frame posted `lumenize:loaded`: with `id`, an echo of a request; without, a fresh load. */
  | { type: 'loaded'; id?: string; at: number; resendId: string }
  /** A request's echo window ran out: 10 s for a landing, 2 s for the button. */
  | { type: 'no-echo'; id: string }
  /** {@link LOAD_SILENCE_MS} after the frame's `load` event at `loadAt`. */
  | { type: 'load-settled'; loadAt: number };

/**
 * - `none` — nothing to do.
 * - `ask` — post `{ type: 'lumenize:reload', id, build }` (no `build` for the button) and arm the
 *   echo window for its kind.
 * - `set-address` — no client answered: navigate the frame to the Star's root, even when it sits
 *   there already.
 */
export type PreviewFrameAction =
  | { kind: 'none' }
  | { kind: 'ask'; request: PendingRequest }
  | { kind: 'set-address' };

/** How long Studio waits for an echo of a landing's request before setting the address. */
export const LANDING_ECHO_MS = 10_000;
/** How long Studio waits for an echo of the Reload button's request. */
export const BUTTON_ECHO_MS = 2_000;
/** How long after the frame's `load` event Studio waits for that load's `loaded`. */
export const LOAD_SILENCE_MS = 2_000;

const NONE: PreviewFrameAction = { kind: 'none' };

export function decidePreviewFrame(
  state: PreviewFrameState, event: PreviewFrameEvent,
): { state: PreviewFrameState; action: PreviewFrameAction } {
  switch (event.type) {
    case 'value': {
      if (event.build === state.build) return { state, action: NONE };
      const request: PendingRequest = { id: event.id, build: event.build, kind: 'landing' };
      return { state: { ...state, build: event.build, pending: request }, action: { kind: 'ask', request } };
    }
    case 'button': {
      const request: PendingRequest = { id: event.id, kind: 'button' };
      return { state: { ...state, pending: request }, action: { kind: 'ask', request } };
    }
    case 'loaded': {
      if (event.id !== undefined) {
        // An echo: a client is there, and it decided. Never force a frame that answered.
        return { state: state.pending?.id === event.id ? { ...state, pending: undefined } : state, action: NONE };
      }
      // A fresh load. A pending button request is answered by the load itself, and resending it
      // would reload the frame again.
      const after: PreviewFrameState = {
        ...state,
        lastLoadedAt: event.at,
        pending: state.pending?.kind === 'button' ? undefined : state.pending,
      };
      if (state.build === undefined || state.resentFor === state.build) return { state: after, action: NONE };
      const request: PendingRequest = { id: event.resendId, build: state.build, kind: 'landing' };
      return { state: { ...after, resentFor: state.build, pending: request }, action: { kind: 'ask', request } };
    }
    case 'no-echo': {
      if (state.pending?.id !== event.id) return { state, action: NONE };
      return { state: { ...state, pending: undefined }, action: { kind: 'set-address' } };
    }
    case 'load-settled': {
      const heard = state.lastLoadedAt !== undefined && state.lastLoadedAt >= event.loadAt - LOAD_SILENCE_MS;
      if (heard || state.pending === undefined) return { state, action: NONE };
      return { state: { ...state, pending: undefined }, action: { kind: 'set-address' } };
    }
  }
}
