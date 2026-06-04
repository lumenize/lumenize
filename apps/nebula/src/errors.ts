/**
 * Shared error types crossing the Star → NebulaClient boundary.
 *
 * Errors are serialized via `@lumenize/structured-clone`'s preprocess/
 * postprocess pipeline. The pipeline preserves `name`, `message`, `stack`,
 * `cause`, and **all custom own properties** ([preprocess.ts:208-227]). On
 * the receiving side `instanceof` does NOT survive — the postprocess
 * pipeline reconstructs via `(globalThis as any)[name] || Error`, so
 * non-built-in subclasses arrive as plain `Error` with the correct `name`
 * and custom fields intact ([postprocess.ts:67-69]).
 *
 * Detection contract for cross-side checks: use `err.name === 'OntologyStaleError'`
 * + property access, not `err instanceof OntologyStaleError`.
 */

export class OntologyStaleError extends Error {
  override name = 'OntologyStaleError';
  constructor(
    public readonly clientVersion: string,
    public readonly currentVersion: string,
  ) {
    super(
      `Ontology version mismatch: client sent '${clientVersion}' but latest is '${currentVersion}'. Refresh your schema.`,
    );
  }
}

/**
 * Cross-boundary detection: type guard for "is this Error an
 * OntologyStaleError-shaped signal?" — works on both server-side
 * (`instanceof` works) and client-side (where the class is reconstructed
 * as plain Error with name preserved).
 */
export function isOntologyStaleError(err: unknown): err is OntologyStaleError {
  return (
    err instanceof Error &&
    err.name === 'OntologyStaleError' &&
    typeof (err as { clientVersion?: unknown }).clientVersion === 'string' &&
    typeof (err as { currentVersion?: unknown }).currentVersion === 'string'
  );
}

import type { PermissionTier } from './dag-ops';

/**
 * Thrown by `DagTree.requirePermission` when the caller lacks the required
 * permission tier on the target node. Carries `tier` and `nodeId` so callers
 * (like `Resources.transaction`'s permission-check loop) can construct a
 * structured `TransactionError` without string-matching the message.
 */
export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
  constructor(
    public readonly tier: PermissionTier,
    public readonly nodeId: number,
  ) {
    super(`${tier} permission required on node ${nodeId}`);
  }
}

export function isPermissionDeniedError(err: unknown): err is PermissionDeniedError {
  return (
    err instanceof Error &&
    err.name === 'PermissionDeniedError' &&
    typeof (err as { nodeId?: unknown }).nodeId === 'number' &&
    typeof (err as { tier?: unknown }).tier === 'string'
  );
}

/**
 * Thrown by `DagTree.requirePermission` (and other DagTree mutators) when
 * the target node doesn't exist. Distinct from `PermissionDeniedError` —
 * this one signals client misuse / stale local DAG, not an authorization
 * failure.
 */
export class NodeNotFoundError extends Error {
  override name = 'NodeNotFoundError';
  constructor(public readonly nodeId: number) {
    super(`Node ${nodeId} not found`);
  }
}

export function isNodeNotFoundError(err: unknown): err is NodeNotFoundError {
  return (
    err instanceof Error &&
    err.name === 'NodeNotFoundError' &&
    typeof (err as { nodeId?: unknown }).nodeId === 'number'
  );
}
