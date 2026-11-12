/**
 * Shared error types crossing the Star → NebulaClient boundary.
 *
 * Errors are serialized via `@lumenize/structured-clone`'s preprocess/
 * postprocess pipeline. The pipeline preserves `name`, `message`, `stack`,
 * `cause`, and **all custom own properties**. On the receiving side
 * `instanceof` does NOT survive — postprocess rebuilds an error with the
 * `globalThis` Error class its `name` names, and these classes are not
 * registered there, so they arrive as plain `Error` with the correct `name`
 * and custom fields intact.
 *
 * Detection contract for cross-side checks: use `err.name === 'OntologyStaleError'`
 * + property access, not `err instanceof OntologyStaleError`.
 */

export class OntologyStaleError extends Error {
  override name = 'OntologyStaleError';
  /**
   * Set when the host has asked its ontology source what is current and the answer will arrive
   * later, by fire-back — a Star asking its Galaxy, on a version mismatch or with nothing
   * installed. The host does not yet know whether it will install anything: when the page is the
   * old one, it installs nothing and the page reloads. Every op is idempotent (a repeated
   * transaction is recognized, reads and subscribes re-run freely), so the client RETRIES it briefly instead of
   * treating the version as stale; only a retry-exhausted or non-`checking` stale surfaces to the
   * refresh-UI path. A cross-node op cannot be awaited (ADR-003), which is why an install arrives
   * as a successful retry rather than as this op's own result.
   */
  public readonly checking?: boolean;
  /**
   * Set on the notice a host pushes when an install or a wipe dropped this client's subscriptions,
   * and unset on the refusal of one of the page's own ops. A refused subscribe arrives on the same
   * push channel as a notice, so the kind rides the error rather than the channel it came on.
   */
  public readonly notice?: boolean;
  constructor(
    public readonly clientVersion: string,
    public readonly currentVersion: string,
    opts: { checking?: boolean; notice?: boolean } = {},
  ) {
    super(
      `Ontology version mismatch: client sent '${clientVersion}' but latest is '${currentVersion}'. Refresh your schema.`,
    );
    if (opts.checking) this.checking = true;
    if (opts.notice) this.notice = true;
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

/**
 * A transaction that awaited validation while its plane was wiped, refused before it could write
 * into the rebuilt tables. Server-internal: the plane answers the caller with an
 * {@link OntologyStaleError} instead, so this never crosses the wire.
 */
export class WipedMidTransactionError extends Error {
  override name = 'WipedMidTransactionError';
  constructor() {
    super('The data plane was wiped while this transaction was validating — nothing was written');
  }
}

/**
 * Thrown by `Resources.actUnderClaimsOf` when the snapshot it was asked to act under is no longer
 * the resource's current one: the resource was written again, or deleted, since the caller read it.
 * Nothing has run when it is thrown. Detect it by `name`, as its neighbours are.
 */
export class ResourceMovedOnError extends Error {
  override name = 'ResourceMovedOnError';
  constructor(
    public readonly resourceId: string,
    /** The `validFrom` the caller named. */
    public readonly named: string,
    /** The resource's current `validFrom`, or absent when it is deleted or was never written. */
    public readonly current?: string,
  ) {
    super(`Resource ${resourceId} has moved on since ${named}: nothing was done under its earlier record`);
  }
}

/** Type guard for {@link ResourceMovedOnError} that works across the wire (`name` + shape). */
export function isResourceMovedOnError(err: unknown): err is ResourceMovedOnError {
  return err instanceof Error && err.name === 'ResourceMovedOnError'
    && typeof (err as { resourceId?: unknown }).resourceId === 'string';
}

import type { PermissionTier } from './org-ops';

/**
 * Thrown by `OrgTree.requirePermission` when the caller lacks the required
 * permission tier on the target node. Carries `tier` and `nodeId` so callers
 * (like `Snapshots.transaction`'s permission-check loop) can construct a
 * structured `TransactionError` without string-matching the message.
 */
export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
  constructor(
    public readonly tier: PermissionTier,
    public readonly nodeId: string,
  ) {
    super(`${tier} permission required on node ${nodeId}`);
  }
}

/**
 * A grant its host seeds as protected was asked to be revoked, or lowered below its declared tier.
 * It is refused to everyone alike, a covering admin included: the grant is part of the tree's
 * skeleton, as the root is, and no permission (ADR-015). Detect it across the wire by `name`.
 */
export class ProtectedGrantError extends Error {
  override name = 'ProtectedGrantError';
  constructor(
    public readonly sub: string,
    public readonly nodeId: string,
    public readonly tier: PermissionTier,
  ) {
    super(`The grant of "${sub}" on node ${nodeId} is protected: its host seeds it, so it cannot be revoked or lowered below ${tier}`);
  }
}

/**
 * For code across the wire, where `instanceof` fails: a refused `client.orgTree.*` mutation reaches
 * the Client as an `Error` named `PermissionDeniedError`, its `tier` and `nodeId` intact. No caller
 * yet; a generated app that shows a refusal, as pre-alpha's *Denied access shows in the app* plans, is one.
 */
export function isPermissionDeniedError(err: unknown): err is PermissionDeniedError {
  return (
    err instanceof Error &&
    err.name === 'PermissionDeniedError' &&
    typeof (err as { nodeId?: unknown }).nodeId === 'string' &&
    typeof (err as { tier?: unknown }).tier === 'string'
  );
}

/**
 * Thrown by `OrgTree.requirePermission` (and other OrgTree mutators) when
 * the target node doesn't exist. Distinct from `PermissionDeniedError` —
 * this one signals client misuse / stale local DAG, not an authorization
 * failure.
 */
export class NodeNotFoundError extends Error {
  override name = 'NodeNotFoundError';
  constructor(public readonly nodeId: string) {
    super(`Node ${nodeId} not found`);
  }
}

/**
 * For code across the wire, where `instanceof` fails: a `client.orgTree.*` mutation naming a node the
 * tree lacks reaches the Client as an `Error` named `NodeNotFoundError`. No caller yet; kept beside
 * {@link isPermissionDeniedError} so a client can tell a stale local tree from a refusal.
 */
export function isNodeNotFoundError(err: unknown): err is NodeNotFoundError {
  return (
    err instanceof Error &&
    err.name === 'NodeNotFoundError' &&
    typeof (err as { nodeId?: unknown }).nodeId === 'string'
  );
}

/**
 * Thrown by `OrgTree.createNode` when the caller-supplied `nodeId` already
 * exists but under a different parent/slug than the request — a reused UUID
 * or client bug, NOT an idempotent replay (which returns the existing node).
 * Loud by design: never a silent `INSERT OR IGNORE` of a mismatched create.
 */
export class NodeIdCollisionError extends Error {
  override name = 'NodeIdCollisionError';
  constructor(public readonly nodeId: string) {
    super(`Node id '${nodeId}' already exists with a different parent or slug (reused UUID?)`);
  }
}


/**
 * Thrown by a resource operation on a client that holds no ontology version.
 *
 * **An app with no resources is a first-class app, so the client BOOTS without a version** — it
 * connects, authenticates, chats and reads profiles. What it cannot do is touch the resource plane,
 * because every op there pins a version the host enforces, and there is nothing to pin: the serving
 * layer injects the version of the last build that landed an ontology, and until a build compiles
 * `src/ontology.d.ts` no version exists. A counter with an increment button never needs one.
 *
 * This is deliberately a refusal at the OPERATION rather than at construction. Refusing to
 * construct would mean a freshly generated app cannot render at all — which it did, blanking the
 * Studio preview on `<div id="app"></div>` with the mount error the only trace.
 */
export class NoOntologyInstalledError extends Error {
  override name = 'NoOntologyInstalledError';
  constructor(public readonly operation: string) {
    super(
      `${operation} needs an ontology version and this app has none. Define its data types in ` +
      `src/ontology.d.ts and build; an app that uses no resources runs fine without it.`,
    );
  }
}

export function isNoOntologyInstalledError(err: unknown): err is NoOntologyInstalledError {
  return (
    err instanceof Error &&
    err.name === 'NoOntologyInstalledError' &&
    typeof (err as { operation?: unknown }).operation === 'string'
  );
}
