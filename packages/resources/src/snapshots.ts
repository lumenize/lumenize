/**
 * Snapshots — temporal storage engine inside every host's resources plane
 *
 * Encapsulates Snodgrass-style snapshot storage for resources attached to
 * org-tree nodes. Uses the host's SQLite and OrgTree's permission system.
 * Follows the same constructor-injection pattern as OrgTree.
 */

import type { CallContext } from '@lumenize/mesh';
import type { AuthClaims } from '@lumenize/mesh';
// ⚠️ VALUE import from Mesh's `/client` subpath, NEVER its root: this module sits in the Node-safe
// client value graph (`client-index.ts` re-exports `END_OF_TIME`), and Mesh's root exports
// `ScopedMeshDO`, which pulls `cloudflare:workers`. `/client` is pure, and `toRecordedClaims` is
// ADR-016's ONE shared projection; no site assembles its own record.
import { toRecordedClaims } from '@lumenize/mesh/client';
import type { RecordedClaims } from '@lumenize/mesh/client';
import { debug } from '@lumenize/debug';
import { PermissionDeniedError, WipedMidTransactionError } from './errors';
import { findUnqueryable } from './query/queryable';
import type { FieldsMap } from './query/fields';
import type {
  ParserValidator,
  ParseRequest,
  ValidationError,
} from '@lumenize/ts-runtime-parser-validator/runtime';
import { stringify, parse } from '@lumenize/structured-clone';
import type { OrgTree } from './org-tree';
import type { PermissionTier } from './org-ops';

// ─── Constants ─────────────────────────────────────────────────────

export const END_OF_TIME = '9999-01-01T00:00:00.000Z';

/**
 * The KV key holding the Durable Object's latest moment: the `validFrom` of the last transaction
 * that wrote. The next moment is minted past it, so moments are unique in the Durable Object and
 * sort in commit order. A `.dev` wipe keeps it (see `PLANE_KEYS` in `resources.ts`).
 */
const LATEST_MOMENT_KEY = 'resources:latestMoment';

// ─── Types ─────────────────────────────────────────────────────────

/**
 * The CLIENT-BOUND attribution projection of the stored ADR-016 record — an ALLOW-LIST (pick, never
 * subtract): identity (`sub` + the complete `act` chain, actor `profileId`s included — display-only,
 * public per ADR-012/013) plus the subject's `profileId`, and nothing else. The column stores the full
 * `RecordedClaims` including the asserted `access`; `access` never rides a snapshot off the DO —
 * a reader has no claim to the writer's asserted authority. Allow-list so a field later added to the record stays withheld without
 * anyone deciding (the same shape as ADR-012's private-by-default).
 */
export interface WireRecordedClaims {
  /** The token's SUBJECT. ⚠️ Under impersonation this is the person acted UPON; the actor is `act.sub`. */
  sub: string;
  act?: AuthClaims['act'];
  profileId: string;
}

export interface SnapshotMeta {
  nodeId: string;
  typeName: string;
  ontologyVersion: string;
  validFrom: string;
  validTo: string;
  recordedClaims: WireRecordedClaims;
  deleted: boolean;
}

export interface Snapshot {
  value: any;
  meta: SnapshotMeta;
}

/**
 * One op of a transaction. A put, move or delete names the version it read as
 * `ifValidFromMatches`, the `validFrom` of the snapshot it saw, and applies only if that is still
 * the resource's current one; a create asserts the resource does not exist.
 */
export type OperationDescriptor =
  | { op: 'create'; nodeId: string; typeName: string; value: any }
  | { op: 'put';    ifValidFromMatches: string; value: any }
  | { op: 'move';   ifValidFromMatches: string; nodeId: string }
  | { op: 'delete'; ifValidFromMatches: string };

export type TransactionError =
  | { type: 'conflict'; currentSnapshot: Snapshot }
  | { type: 'validation'; errors: ValidationError[] }
  | { type: 'permission'; requiredTier: PermissionTier; nodeId: string };

/**
 * A committed transaction answers its one moment, the `validFrom` of every snapshot it wrote; a
 * repeat of one that committed answers the moment it committed at; an empty one answers the latest
 * moment, or the current time in a Durable Object that has none.
 */
export type TransactionResult =
  | { ok: true;  validFrom: string }
  | { ok: false; errors: Record<string, TransactionError> };

/**
 * Options for {@link Snapshots.transaction}. None of them says who is writing or skips a check:
 * a write records the claims its call carries, and every op passes the tree's permission check
 * under them (ADR-025). Host code that writes as someone other than its caller runs the write
 * under those claims, with `lmz.asLocalPrincipal` or `lmz.actFor`.
 */
export interface TransactionOpts {
  /** Post-commit hook, invoked with the written snapshots (fanout + query reruns). */
  onMutations?: (mutations: Map<string, Snapshot>) => void;
  /** False once the plane that started this transaction has been wiped. Checked after
   *  validation's `await`, the one place a commit can pause, so a commit that paused across a
   *  wipe writes nothing into the rebuilt tables and throws {@link WipedMidTransactionError}. */
  stillCurrent?: () => boolean;
  /**
   * The installed ontology's fields. With them, a value a query would read wrongly is refused as a
   * validation failure: `Infinity` in a number field, an invalid `Date`, one object stored at two
   * places (`src/query/queryable.ts`). A row compiled before queries took a filter has none, and
   * its writes are not checked.
   */
  fields?: FieldsMap;
}

/** Allow-list pick for the wire — see {@link WireRecordedClaims}. */
function toWireRecordedClaims(rec: RecordedClaims): WireRecordedClaims {
  return {
    sub: rec.sub,
    ...(rec.act && { act: rec.act }),
    profileId: rec.profileId,
  };
}

/** Structural walk shape for {@link identityKey} — both the stored record and the wire projection fit. */
type ActChainLike = { sub: string; act?: ActChainLike };

/**
 * Who wrote a snapshot, for recognizing a repeat — IDENTITY ONLY: the subject's `sub` plus the `act`
 * chain's `sub`s, in chain order. A repeat is the same write only when its writer is the same, and a
 * resend can arrive under a re-minted token whose other claims differ: `access` flips on a
 * promotion, and a `profileId` (the subject's or an actor's) re-points on a future
 * `sub`-unification. So the stored record must NOT be the key. The chain stays in it: a write made
 * under impersonation and resent from the member's own session is a different writer's.
 */
function identityKey(t: { sub: string; act?: ActChainLike }): string {
  const subs: string[] = [t.sub];
  for (let a = t.act; a; a = a.act) subs.push(a.sub);
  return JSON.stringify(subs);
}

/** A snapshot row as recognition compares it: the value in stored form, the writer as its identity. */
interface StoredRow {
  validFrom: string;
  nodeId: string;
  typeName: string;
  deleted: boolean;
  value: string;
  writer: string;
}

function storedRow(row: Record<string, SqlStorageValue>): StoredRow {
  return {
    validFrom: row.validFrom as string,
    nodeId: row.nodeId as string,
    typeName: row.typeName as string,
    deleted: Boolean(row.deleted),
    value: row.value as string,
    writer: identityKey(JSON.parse(row.recordedClaims as string) as RecordedClaims),
  };
}

// ─── Snapshots Class ───────────────────────────────────────────────

/**
 * Refuses an op that lacks a field its kind requires, naming the field. The ontology validates a
 * resource's `value`; these are the op's own fields, which no type check reaches once a call has
 * crossed the wire. A missing `value` is refused inside the transaction, with the other checks
 * that read the stored resource.
 */
function assertOpFields(resourceId: string, op: OperationDescriptor): void {
  const given = (op ?? {}) as { op?: unknown; typeName?: unknown; nodeId?: unknown; ifValidFromMatches?: unknown };
  const missing = (field: string, what: string): never => {
    throw new Error(`A ${String(given.op)} needs \`${field}\`, ${what}, and '${resourceId}' has none`);
  };
  const has = (v: unknown) => typeof v === 'string' && v !== '';
  switch (given.op) {
    case 'create':
      if (!has(given.typeName)) missing('typeName', "the ontology type of the resource's value");
      if (!has(given.nodeId)) missing('nodeId', 'the org-tree node the resource attaches to');
      return;
    case 'move':
      if (!has(given.nodeId)) missing('nodeId', 'the org-tree node the resource moves to');
      if (!has(given.ifValidFromMatches)) missing('ifValidFromMatches', 'the version the caller last saw');
      return;
    case 'put':
    case 'delete':
      if (!has(given.ifValidFromMatches)) missing('ifValidFromMatches', 'the version the caller last saw');
      return;
    default:
      throw new Error(`Unknown op '${String(given.op)}' on '${resourceId}': an op is create, put, move or delete`);
  }
}

export class Snapshots {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #orgTree: OrgTree;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    orgTree: OrgTree,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#orgTree = orgTree;
    this.#createSchema();
  }

  // ─── Schema ───────────────────────────────────────────────────────

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Snapshots (
        resourceId TEXT NOT NULL,
        nodeId TEXT NOT NULL,
        typeName TEXT NOT NULL,
        ontologyVersion TEXT NOT NULL,
        validFrom TEXT NOT NULL,
        validTo TEXT NOT NULL DEFAULT '${END_OF_TIME}',
        recordedClaims TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        value TEXT NOT NULL,
        PRIMARY KEY (resourceId, validFrom),
        FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Snapshots_current
        ON Snapshots(resourceId, validTo)
        WHERE validTo = '${END_OF_TIME}';
    `);
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * The resource's current snapshot, a tombstone included. Read by primary key, latest moment
   * first: every write closes the row before it and opens one at a later moment, so the last row
   * is the current one. A `validTo = END_OF_TIME` filter would read no fewer rows, because with no
   * statistics SQLite searches the primary key's `resourceId` prefix rather than the partial index,
   * walking every past snapshot of the resource.
   */
  #getCurrentSnapshot(resourceId: string): Snapshot | null {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, recordedClaims, deleted, value
       FROM Snapshots
       WHERE resourceId = ?
       ORDER BY validFrom DESC
       LIMIT 1`,
      resourceId,
    ).toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      value: parse(row.value as string),
      meta: {
        nodeId: row.nodeId as string,
        typeName: row.typeName as string,
        ontologyVersion: row.ontologyVersion as string,
        validFrom: row.validFrom as string,
        validTo: row.validTo as string,
        // The ONE wire choke point: every outbound Snapshot — read(), a conflict's currentSnapshot,
        // the post-write fanout capture — is built here, so the allow-list projection here is what
        // keeps the stored `access` inside the column.
        recordedClaims: toWireRecordedClaims(JSON.parse(row.recordedClaims as string) as RecordedClaims),
        deleted: Boolean(row.deleted),
      },
    };
  }

  /**
   * The moment a committing transaction writes at: the later of now and one millisecond past the
   * latest moment, compared as ISO strings, which sort as they compare because every moment has
   * `toISOString()`'s fixed width (ADR-011). Called inside the `transactionSync` that writes, so
   * no other transaction can take a moment between the read and the write. Above about 1,000
   * commits a second each commit pushes the moment a millisecond ahead, and `validFrom` runs ahead
   * of the clock until the rate drops.
   */
  #nextMoment(): string {
    const latestMoment = this.#ctx.storage.kv.get<string>(LATEST_MOMENT_KEY);
    const now = new Date().toISOString();
    const next = latestMoment ? new Date(Date.parse(latestMoment) + 1).toISOString() : now;
    return next > now ? next : now;
  }

  /** Project the claims the write's call carries into the ADR-016 record, whole: its subject and
   *  the complete `act` chain beneath. Nothing is added here. */
  #buildRecordedClaims(): RecordedClaims {
    const cc = this.#getCallContext();
    const payload = cc.originAuth?.claims as unknown as AuthClaims;
    return toRecordedClaims(payload);
  }

  #writeSnapshot(
    resourceId: string,
    current: Snapshot | null,
    op: OperationDescriptor,
    validFrom: string,
    recordedClaims: RecordedClaims,
    typeName: string,
    ontologyVersion: string,
  ): void {
    // Determine new values based on op type
    let nodeId: string;
    let value: string;
    let deleted: boolean;

    switch (op.op) {
      case 'create':
        nodeId = op.nodeId;
        value = stringify(op.value);
        deleted = false;
        break;
      case 'put':
        nodeId = current!.meta.nodeId;
        value = stringify(op.value);
        deleted = current!.meta.deleted;
        break;
      case 'move':
        nodeId = op.nodeId;
        value = stringify(current!.value);
        deleted = current!.meta.deleted;
        break;
      case 'delete':
        nodeId = current!.meta.nodeId;
        value = stringify(current!.value);
        deleted = true;
        break;
    }

    // The FULL record goes into the column (ADR-016: `sub` + complete `act` chain + `profileId` +
    // asserted `access`); the wire copies are projected at #getCurrentSnapshot.
    const recordedClaimsJson = JSON.stringify(recordedClaims);

    // Every committed op is a snapshot: close the current one, then open one at this moment.
    if (current) {
      this.#ctx.storage.sql.exec(
        `UPDATE Snapshots SET validTo = ? WHERE resourceId = ? AND validFrom = ?`,
        validFrom, resourceId, current.meta.validFrom,
      );
    }

    // Insert new snapshot
    this.#ctx.storage.sql.exec(
      `INSERT INTO Snapshots (resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, recordedClaims, deleted, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      resourceId, nodeId, typeName, ontologyVersion, validFrom, END_OF_TIME, recordedClaimsJson, deleted ? 1 : 0, value,
    );
  }

  /**
   * The snapshot that followed the one at `version`, with what that one held, or `null` when the
   * resource never had `version` or it is still current. Two primary-key reads in one statement:
   * the old row's `validTo` is its successor's `validFrom`.
   */
  #successorOf(resourceId: string, version: string): { before: StoredRow; after: StoredRow } | null {
    const row = this.#ctx.storage.sql.exec(
      `SELECT b.nodeId AS bNode, b.deleted AS bDeleted, b.value AS bValue,
              a.validFrom, a.nodeId, a.typeName, a.deleted, a.value, a.recordedClaims
       FROM Snapshots b JOIN Snapshots a ON a.resourceId = b.resourceId AND a.validFrom = b.validTo
       WHERE b.resourceId = ? AND b.validFrom = ?`,
      resourceId, version,
    ).toArray()[0];
    if (!row) return null;
    return {
      before: { validFrom: version, nodeId: row.bNode as string, typeName: row.typeName as string,
        deleted: Boolean(row.bDeleted), value: row.bValue as string, writer: '' },
      after: storedRow(row),
    };
  }

  /** The resource's first snapshot, the one its create wrote, or `null` when it has none. */
  #firstSnapshotOf(resourceId: string): StoredRow | null {
    const row = this.#ctx.storage.sql.exec(
      `SELECT validFrom, nodeId, typeName, deleted, value, recordedClaims
       FROM Snapshots WHERE resourceId = ? ORDER BY validFrom ASC LIMIT 1`,
      resourceId,
    ).toArray()[0];
    return row ? storedRow(row) : null;
  }

  /**
   * The moment a repeat of a committed transaction committed at, or `null` when `entries` is not
   * one. It is a repeat when, for every op, the snapshot that op would have written exists — the
   * one that followed the version a put, move or delete names, or a create's first snapshot — and
   * all of them share one moment, were written by `writer`, and hold what the op writes, compared
   * in stored form after the validator filled any `@default`. Returns only a moment, and judges the
   * writer by identity alone, never by the stored `access` or `aud`.
   *
   * `current` is each resource's latest snapshot, deleted or not, as the transaction read it. It
   * rules out most writes with no read of its own: a create of a resource that has no snapshot,
   * and a put, move or delete naming the version still current, wrote nothing a repeat could match.
   */
  #recognize(entries: Array<[string, OperationDescriptor]>, writer: string,
    current: Map<string, Snapshot | null>): string | null {
    let moment: string | undefined;
    for (const [resourceId, op] of entries) {
      const latest = current.get(resourceId) ?? null;
      if (op.op === 'create' ? latest === null
        : latest === null || latest.meta.validFrom === op.ifValidFromMatches) return null;
      let written: StoredRow | null;
      let same: boolean;
      if (op.op === 'create') {
        written = this.#firstSnapshotOf(resourceId);
        same = written !== null && written.nodeId === op.nodeId && written.typeName === op.typeName
          && !written.deleted && written.value === stringify(op.value);
      } else {
        const pair = this.#successorOf(resourceId, op.ifValidFromMatches);
        written = pair?.after ?? null;
        const before = pair?.before;
        same = written !== null && before !== undefined && (
          op.op === 'put' ? written.nodeId === before.nodeId && written.deleted === before.deleted
            && written.value === stringify(op.value)
          : op.op === 'move' ? written.nodeId === op.nodeId && written.deleted === before.deleted
            && written.value === before.value
          : written.nodeId === before.nodeId && written.deleted && written.value === before.value);
      }
      if (!written || !same || written.writer !== writer) return null;
      if (moment !== undefined && written.validFrom !== moment) return null;
      moment = written.validFrom;
    }
    return moment ?? null;
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * The full record of a resource's current snapshot, `access` and `aud` included, with the moment
   * it was written at. No permission check, and never handed to a Client as a snapshot: every
   * read a Client can reach goes through {@link read}'s allow-list instead. Its one caller is
   * `Resources.actUnderClaimsOf`, which runs a block under the record, so the claims then ride
   * that block's calls as any caller's do.
   */
  currentRecord(resourceId: string): { validFrom: string; deleted: boolean; recordedClaims: RecordedClaims } | null {
    const row = this.#ctx.storage.sql.exec(
      `SELECT validFrom, deleted, recordedClaims FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1`,
      resourceId,
    ).toArray()[0];
    if (!row) return null;
    return {
      validFrom: row.validFrom as string,
      deleted: Boolean(row.deleted),
      recordedClaims: JSON.parse(row.recordedClaims as string) as RecordedClaims,
    };
  }

  read(resourceId: string): Snapshot | null {
    const snapshot = this.#getCurrentSnapshot(resourceId);
    if (!snapshot) return null;

    // Permission check — throws on failure
    this.#orgTree.requirePermission(snapshot.meta.nodeId, 'read');
    return snapshot;
  }

  /**
   * Up to `limit` live resources, each with its type and value, with NO permission check — what a
   * version change checks against the new validator on the `.dev` Star. Nothing reaches it from
   * the wire.
   */
  liveValues(limit: number): Array<{ resourceId: string; typeName: string; value: unknown }> {
    return this.#ctx.storage.sql.exec(
      `SELECT resourceId, typeName, value FROM Snapshots WHERE validTo = ? AND deleted = 0 LIMIT ?`,
      END_OF_TIME, limit,
    ).toArray().map((row) => ({
      resourceId: row.resourceId as string, typeName: row.typeName as string, value: parse(row.value as string),
    }));
  }

  /**
   * The current snapshot of each of `resourceIds` that has one, built by the same projection as
   * {@link read}, so `meta.recordedClaims` carries no `access` and no `aud`. NO permission check:
   * its one caller, the plane's one-time query read, has already evaluated `read` on each id's
   * node. Nothing reaches it from the wire.
   */
  currentSnapshots(resourceIds: string[]): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>();
    for (const resourceId of resourceIds) {
      const snapshot = this.#getCurrentSnapshot(resourceId);
      if (snapshot) out.set(resourceId, snapshot);
    }
    return out;
  }

  /**
   * The current type name of a resource, or `undefined` if it has no live snapshot — with NO
   * permission check and nothing else from the snapshot. A resource subscribe denied on the node
   * uses it to refuse a subscriber who named the wrong type without saying what the right one
   * is; nothing reaches it from the wire.
   */
  currentTypeName(resourceId: string): string | undefined {
    const row = this.#ctx.storage.sql.exec(
      `SELECT typeName FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1`,
      resourceId,
    ).toArray()[0];
    return row ? (row.typeName as string) : undefined;
  }

  async transaction(
    ops: Record<string, OperationDescriptor>,
    ontologyVersion: string,
    facet: ParserValidator,
    opts: TransactionOpts = {},
  ): Promise<TransactionResult> {
    const { onMutations, stillCurrent } = opts;
    const entries = Object.entries(ops);
    // An empty transaction writes nothing and answers the latest moment.
    if (entries.length === 0) {
      return { ok: true, validFrom: this.#ctx.storage.kv.get<string>(LATEST_MOMENT_KEY) ?? new Date().toISOString() };
    }

    // Validate resourceIds
    for (const [resourceId, op] of entries) {
      if (!resourceId) throw new Error('resourceId must not be empty');
      assertOpFields(resourceId, op);
    }

    // Step 1: Read current snapshots outside transaction (for the Step 4.5 pre-check)
    const currentSnapshots = new Map<string, Snapshot | null>();
    for (const [resourceId] of entries) {
      currentSnapshots.set(resourceId, this.#getCurrentSnapshot(resourceId));
    }

    // Step 4: Build the recorded claims from callContext
    const recordedClaims = this.#buildRecordedClaims();
    const writer = identityKey(recordedClaims);

    // Step 4.5: Monotonic pre-check (before the validator). It may ONLY act on a conclusion a
    // concurrent commit can't reverse between the Step-1 read and the txn: a resource whose current
    // `validFrom` is not the one the op names has moved on, and versions only move forward, so the
    // op WILL conflict at Step 9 — unless it is a repeat of a write that committed, which recognition
    // answers. So a suspect skips its validator work only when the snapshot that followed the version
    // it names was written by someone else; that snapshot never changes once written, so the check
    // stays monotonic, and a possible repeat still reaches the validator, whose filled value
    // recognition compares. A hint, never a verdict: it returns NOTHING to the caller, because
    // disclosing a snapshot must wait for the Step-8 permission gate. Skipping validation here is
    // also what makes conflict win over an invalid value when both co-occur on one resource. Absent
    // `current` (not-found) is deferred to the authoritative Step 7; it isn't monotonic.
    const conflictSuspects = new Set<string>();
    for (const [resourceId, op] of entries) {
      if (op.op === 'create') continue;
      const current = currentSnapshots.get(resourceId);
      if (current && current.meta.validFrom !== op.ifValidFromMatches
          && this.#successorOf(resourceId, op.ifValidFromMatches)?.after.writer !== writer) {
        conflictSuspects.add(resourceId);
      }
    }

    // Step 5: Parse + validate via facet (one batch call). `parse()` fills
    // `@default` values into a fresh object per item; on success we write
    // `result.data` back so downstream Step 6.5+ sees the filled value.
    // Skip ops where validation can't or shouldn't run — Step 7 catches them.
    const requests = new Map<string, ParseRequest>();
    for (const [resourceId, op] of entries) {
      if (conflictSuspects.has(resourceId)) continue; // doomed to conflict at Step 9 — don't validate
      if (op.op === 'create') {
        if (op.value == null) continue;
        requests.set(resourceId, { value: op.value, typeName: op.typeName });
      } else if (op.op === 'put') {
        if (op.value == null) continue;
        const current = currentSnapshots.get(resourceId);
        if (!current) continue;
        requests.set(resourceId, { value: op.value, typeName: current.meta.typeName });
      }
      // delete and move — no validation needed
    }

    const validationErrors: Record<string, TransactionError> = {};
    if (requests.size > 0) {
      const log = debug('nebula.Snapshots.transaction');
      let results;
      try {
        results = await facet.parseBatch(requests);
      } catch (err) {
        // Facet load failure (Worker Loader compile error), RPC transport
        // failure, or unexpected internal error. Validation failures don't
        // throw — they come back as `{ valid: false, errors }` in the result.
        log.error('facet.parseBatch threw', {
          ontologyVersion,
          requestCount: requests.size,
          typeNames: [...new Set([...requests.values()].map(r => r.typeName))],
          error: err,
        });
        throw err;
      }
      for (const [resourceId, result] of results) {
        if (result.valid) {
          const op = ops[resourceId];
          if (op.op === 'create' || op.op === 'put') {
            op.value = result.data;
            // Checked on the value as it will be stored, defaults filled, since that is what a
            // query reads.
            const typeName = requests.get(resourceId)!.typeName;
            const unqueryable = opts.fields && Object.hasOwn(opts.fields, typeName)
              ? findUnqueryable(opts.fields, typeName, stringify(op.value)) : [];
            if (unqueryable.length > 0) {
              validationErrors[resourceId] = {
                type: 'validation',
                errors: unqueryable.map((issue) => ({ path: `$input.${issue.path}`, expected: issue.message, value: undefined })),
              };
            }
          }
        } else {
          validationErrors[resourceId] = { type: 'validation', errors: result.errors };
        }
      }
      const failureCount = Object.keys(validationErrors).length;
      if (failureCount > 0) {
        log.warn('validation failures', {
          ontologyVersion,
          count: failureCount,
          requestCount: requests.size,
          sampleErrors: Object.entries(validationErrors).slice(0, 3).map(
            ([id, e]) => ({ resourceId: id, errors: (e as { type: 'validation'; errors: ValidationError[] }).errors }),
          ),
        });
      }
    }
    if (Object.keys(validationErrors).length > 0) {
      return { ok: false, errors: validationErrors };
    }
    if (stillCurrent && !stillCurrent()) throw new WipedMidTransactionError();

    // Steps 6–10: Atomic transaction
    let result: TransactionResult = { ok: false, errors: {} };
    const writtenSnapshots = new Map<string, Snapshot>();

    this.#ctx.storage.transactionSync(() => {
      // Step 6: Re-read inside transaction (authoritative for the precondition)
      const authoritative = new Map<string, Snapshot | null>();
      for (const [resourceId] of entries) {
        authoritative.set(resourceId, this.#getCurrentSnapshot(resourceId));
      }

      // Step 6.5: A repeat of a transaction that committed is answered with the moment it committed
      // at, from the snapshots it wrote, and writes nothing. Before op validation, the permission
      // check and the conflict check, so none of them refuses a write that landed — a repeated
      // create would otherwise fail "already exists", and a repeated put conflict with its own
      // write. Only the door's version rule comes first: a repeat pinned to an older ontology is
      // answered stale. A write whose Step-6 read already rules a repeat out costs no read here.
      const repeatOf = this.#recognize(entries, writer, authoritative);
      if (repeatOf !== null) {
        result = { ok: true, validFrom: repeatOf };
        return;
      }

      // Step 7: Validate operations
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId)!;

        if (op.op === 'create') {
          if (current) {
            throw new Error(`Resource '${resourceId}' already exists — use put instead`);
          }
          if (op.value == null) {
            throw new Error(`Value must not be null or undefined for create on '${resourceId}'`);
          }
        } else {
          // put, move, delete — resource must exist
          if (!current) {
            throw new Error(`Resource '${resourceId}' not found`);
          }
          if (op.op === 'put' && op.value == null) {
            throw new Error(`Value must not be null or undefined for put on '${resourceId}'`);
          }
        }
      }

      // Step 8: Permission checks. Collect all failures into a typed
      // `TransactionError` rather than throwing on the first denial — the
      // client wants to know about every affected resource, not just the
      // first one it happened to ask about.
      const permErrors: Record<string, TransactionError> = {};
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId) ?? null;
        try {
          switch (op.op) {
            case 'create':
              this.#orgTree.requirePermission(op.nodeId, 'write');
              break;
            case 'put':
            case 'delete':
              this.#orgTree.requirePermission(current!.meta.nodeId, 'write');
              break;
            case 'move':
              this.#orgTree.requirePermission(current!.meta.nodeId, 'write');
              this.#orgTree.requirePermission(op.nodeId, 'write');
              break;
          }
        } catch (e) {
          // Permission denial is collected into a typed `TransactionError` so
          // the client learns about every affected resource, not just the
          // first one it asked about. Anything else (`NodeNotFoundError`,
          // "Authentication required", system errors) signals client misuse
          // or system failure and propagates up to the Star @mesh handler.
          if (!(e instanceof PermissionDeniedError)) {
            throw e;
          }
          // For 'move' both the source and destination are checked — record
          // the first failing nodeId (source checked first); good enough
          // for demo, refine if mover-targets need disambiguation.
          permErrors[resourceId] = { type: 'permission', requiredTier: e.tier, nodeId: e.nodeId };
        }
      }

      if (Object.keys(permErrors).length > 0) {
        result = { ok: false, errors: permErrors };
        return;
      }

      // Step 9: Check each op's named version — conflicts produce { ok: false }. This is the
      // ONLY place a conflict is decided or a `currentSnapshot` disclosed —
      // deliberately AFTER the Step-8 permission gate (the Step-4.5 scan only
      // skips doomed validator work; it returns nothing to the caller). Runs
      // against the in-txn snapshot, so it also catches conflicts that
      // appeared during the validator's await and returns the freshest
      // currentSnapshot for the resolver.
      const errors: Record<string, TransactionError> = {};
      for (const [resourceId, op] of entries) {
        if (op.op === 'create') continue;
        const current = authoritative.get(resourceId)!;
        if (current.meta.validFrom !== op.ifValidFromMatches) {
          errors[resourceId] = { type: 'conflict', currentSnapshot: current };
        }
      }

      if (Object.keys(errors).length > 0) {
        result = { ok: false, errors };
        return; // nothing has been written, and the latest moment is untouched
      }

      // Step 10: Write all changes at one moment, taken here, after the validator's `await`, so
      // moments sort in commit order. Every op writes a snapshot, a move to the node a resource is
      // already on included.
      const validFrom = this.#nextMoment();
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId) ?? null;
        const typeName = op.op === 'create'
          ? op.typeName
          : authoritative.get(resourceId)!.meta.typeName;
        this.#writeSnapshot(resourceId, current, op, validFrom, recordedClaims, typeName, ontologyVersion);

        // Capture the post-write snapshot for fanout. Re-read inside the
        // transactionSync so the captured value matches what was actually
        // committed. Soft-delete carries `meta.deleted: true` — we pass the
        // real Snapshot, never null, per the user-facing decision in 5.3.1.
        const written = this.#getCurrentSnapshot(resourceId);
        if (written) writtenSnapshots.set(resourceId, written);
      }

      this.#ctx.storage.kv.put(LATEST_MOMENT_KEY, validFrom);
      result = { ok: true, validFrom };
    });

    if (result.ok && writtenSnapshots.size > 0 && onMutations) {
      onMutations(writtenSnapshots);
    }

    return result;
  }
}
