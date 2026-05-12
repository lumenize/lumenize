/**
 * @lumenize/state — path-based reactive store.
 *
 * Construct via `createState()`; subscribe with `state.subscribe(path, cb)`;
 * read/write with `getState` / `setState`; derive with `computed`; install
 * cross-cutting concerns with `state.use(middleware)`.
 *
 * The public `subscribe(path, cb, hierarchical = true)` fires on exact,
 * ancestor, and descendant writes — deliberate divergence from the JurisJS
 * source this was ported from (which only fired exact + descendant).
 */

export { StateManager, ComputedSelfReferenceError } from './state-manager';
export type { Middleware, SubscriberCallback, ComputedFn } from './state-manager';
export { isValidPath, getPathParts, deepEquals } from './helpers';

import { StateManager, type Middleware } from './state-manager';

/**
 * Construct a `StateManager`. Prefer this over `new StateManager(...)` —
 * it leaves a wrapping point if construction ever needs more than the class
 * direct, and keeps call sites short.
 */
export function createState(
  initialState: Record<string, unknown> = {},
  middleware: Middleware[] = [],
): StateManager {
  return new StateManager(initialState, middleware);
}
