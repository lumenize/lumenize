/**
 * Error thrown when a fetch request times out via the alarm backstop.
 *
 * **Important:** This error is ambiguous - the external API may have processed
 * the request before the timeout. For non-idempotent operations, check the
 * external system's state before retrying.
 *
 * @example
 * ```typescript
 * @mesh
 * handleResult(result: ResponseSync | Error) {
 *   if (result instanceof FetchTimeoutError) {
 *     // Ambiguous - fetch may have succeeded
 *     // Check external state before retrying non-idempotent operations
 *     return;
 *   }
 *   if (result instanceof Error) {
 *     // Definite failure - safe to retry
 *     return;
 *   }
 *   // Success
 * }
 * ```
 */
export class FetchTimeoutError extends Error {
  name = 'FetchTimeoutError';

  constructor(message: string, public readonly url: string) {
    super(message);
  }
}

// Register on globalThis so it survives serialization across Workers RPC
(globalThis as any).FetchTimeoutError = FetchTimeoutError;
