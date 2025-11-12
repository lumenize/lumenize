/**
 * @lumenize/core/ocan - Operation Chaining And Nesting
 * 
 * Core infrastructure for building and executing operation chains.
 * Used by @lumenize/rpc, @lumenize/call, @lumenize/alarms, and @lumenize/proxy-fetch.
 */

// Types
export type {
  Operation,
  OperationChain,
  NestedOperationMarker,
  OcanConfig
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
  validateOperationChain
} from './execute.js';

