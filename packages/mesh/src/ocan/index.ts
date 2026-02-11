/**
 * @lumenize/mesh/ocan - Operation Chaining And Nesting
 * 
 * Core infrastructure for building and executing operation chains.
 * Used by @lumenize/rpc, this.lmz.call(), this.svc.alarms, and @lumenize/fetch.
 */

// Continuation types (centralized here for consistent branding)
export type {
  Continuation,
  AnyContinuation,
} from './types.js';

// Types
export type {
  Operation,
  OperationChain,
  NestedOperationMarker,
  OcanConfig,
  Unprotected
} from './types.js';

export {
  isNestedOperationMarker
} from './types.js';

// Proxy factory for building chains
export {
  newContinuation,
  getOperationChain
} from './proxy-factory.js';

// Execution
export {
  executeOperationChain,
  validateOperationChain,
  replaceNestedOperationMarkers
} from './execute.js';

