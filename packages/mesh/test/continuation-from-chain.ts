import { newContinuation, type OperationChain } from '../src/ocan/index.js';

/**
 * Rebuild a continuation from a hand-built operation chain, so a test can send a forged chain —
 * one no `ctn()` would produce — through a real `lmz.call`, which accepts only a continuation.
 *
 * A chain holds only `get` and `apply` steps, and the continuation proxy records every string key
 * and argument as given, so replaying the steps onto a fresh continuation reproduces the chain.
 * `@lumenize/mesh` exported a function of this name until 2026-09-27; its one production caller
 * was the recursive broadcast tier, which forwarded chains it had received.
 */
export function continuationFromChain<T = any>(chain: OperationChain): T {
  let continuation: any = newContinuation();
  for (const op of chain) {
    continuation = op.type === 'get' ? continuation[op.key] : continuation(...op.args);
  }
  return continuation as T;
}
