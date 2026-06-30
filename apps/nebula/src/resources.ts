/**
 * Resources — temporal storage engine inside a Star DO
 *
 * Encapsulates Snodgrass-style snapshot storage for resources attached to
 * DAG tree nodes. Uses Star's SQLite and DagTree's permission system.
 * Follows the same constructor-injection pattern as DagTree.
 */

import type { CallContext } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import type { ActClaim } from '@lumenize/auth';
import { debug } from '@lumenize/debug';
import { PermissionDeniedError } from './errors';
import type {
  ParserValidator,
  ParseRequest,
  ValidationError,
} from '@lumenize/ts-runtime-parser-validator';
import { stringify, parse } from '@lumenize/structured-clone';
import type { DagTree } from './dag-tree';
import type { PermissionTier } from './dag-ops';

// ─── Constants ─────────────────────────────────────────────────────

export const END_OF_TIME = '9999-01-01T00:00:00.000Z';

// ─── Types ─────────────────────────────────────────────────────────

export interface SnapshotMeta {
  nodeId: number;
  typeName: string;
  ontologyVersion: string;
  eTag: string;
  validFrom: string;
  validTo: string;
  changedBy: ActClaim;
  deleted: boolean;
}

export interface Snapshot {
  value: any;
  meta: SnapshotMeta;
}

export type OperationDescriptor =
  | { op: 'create'; nodeId: number; typeName: string; value: any }
  | { op: 'put';    eTag: string; value: any }
  | { op: 'move';   eTag: string; nodeId: number }
  | { op: 'delete'; eTag: string };

export type TransactionError =
  | { type: 'conflict'; currentSnapshot: Snapshot }
  | { type: 'validation'; errors: ValidationError[] }
  | { type: 'permission'; requiredTier: PermissionTier; nodeId: number };

export type TransactionResult =
  | { ok: true;  eTags: Record<string, string> }
  | { ok: false; errors: Record<string, TransactionError> };

// ─── Resources Class ───────────────────────────────────────────────

export class Resources {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #dagTree: DagTree;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    dagTree: DagTree,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#dagTree = dagTree;
    this.#createSchema();
    this.#bootstrapConfig();
  }

  // ─── Schema & Config ──────────────────────────────────────────────

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Snapshots (
        resourceId TEXT NOT NULL,
        nodeId INTEGER NOT NULL,
        typeName TEXT NOT NULL,
        ontologyVersion TEXT NOT NULL,
        validFrom TEXT NOT NULL,
        validTo TEXT NOT NULL DEFAULT '${END_OF_TIME}',
        eTag TEXT NOT NULL,
        changedBy TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        PRIMARY KEY (resourceId, validFrom),
        FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Snapshots_current
        ON Snapshots(resourceId, validTo)
        WHERE validTo = '${END_OF_TIME}';
    `);
  }

  #bootstrapConfig() {
    const config = this.#ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    let dirty = false;
    if (!('debounceMs' in config)) { config.debounceMs = 3_600_000; dirty = true; }
    if (dirty) this.#ctx.storage.kv.put('config', config);
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  #getCurrentSnapshot(resourceId: string): Snapshot | null {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, eTag, changedBy, deleted, value
       FROM Snapshots
       WHERE resourceId = ? AND validTo = ?`,
      resourceId, END_OF_TIME,
    ).toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      value: parse(row.value as string),
      meta: {
        nodeId: row.nodeId as number,
        typeName: row.typeName as string,
        ontologyVersion: row.ontologyVersion as string,
        eTag: row.eTag as string,
        validFrom: row.validFrom as string,
        validTo: row.validTo as string,
        changedBy: JSON.parse(row.changedBy as string) as ActClaim,
        deleted: Boolean(row.deleted),
      },
    };
  }

  /**
   * Calculate validFrom for a transaction batch.
   *
   * Uses Date.now() as the starting timestamp, then checks all resources in the
   * batch — if Date.now() is <= any existing snapshot's validFrom, it advances
   * to prev + 1. This is intentional and correct for Cloudflare Workers where
   * the clock doesn't advance during synchronous execution: for a multi-resource
   * transaction, the result is always at least 1ms above the highest existing
   * validFrom across all resources.
   */
  #calculateValidFrom(currentSnapshots: Map<string, Snapshot | null>): string {
    let ts = Date.now();

    for (const [, snap] of currentSnapshots) {
      if (snap) {
        const prev = new Date(snap.meta.validFrom).getTime();
        if (ts <= prev) {
          ts = prev + 1;
        }
      }
    }

    return new Date(ts).toISOString();
  }

  #buildChangedBy(): ActClaim {
    const cc = this.#getCallContext();
    const payload = cc.originAuth?.claims as unknown as NebulaJwtPayload;
    return { sub: payload.sub, ...(payload.act && { act: payload.act }) };
  }

  #writeSnapshot(
    resourceId: string,
    current: Snapshot | null,
    op: OperationDescriptor,
    validFrom: string,
    eTag: string,
    changedBy: ActClaim,
    typeName: string,
    ontologyVersion: string,
  ): void {
    const config = this.#ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    const debounceMs = (config.debounceMs as number) ?? 3_600_000;

    // Determine new values based on op type
    let nodeId: number;
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
        // Move to same node — idempotent no-op handled by caller
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

    const changedByJson = JSON.stringify(changedBy);

    // Debounce check: same actor within window overwrites in place
    if (current && op.op !== 'create') {
      const withinWindow = Date.now() - new Date(current.meta.validFrom).getTime() < debounceMs;
      const sameActor = JSON.stringify(current.meta.changedBy) === changedByJson;

      if (withinWindow && sameActor) {
        // Overwrite in place — same PK (resourceId, validFrom), new value/eTag
        this.#ctx.storage.sql.exec(
          `UPDATE Snapshots
           SET nodeId = ?, typeName = ?, ontologyVersion = ?, eTag = ?, changedBy = ?, deleted = ?, value = ?
           WHERE resourceId = ? AND validFrom = ?`,
          nodeId, typeName, ontologyVersion, eTag, changedByJson, deleted ? 1 : 0, value,
          resourceId, current.meta.validFrom,
        );
        return;
      }

      // New timeline entry: close current snapshot
      this.#ctx.storage.sql.exec(
        `UPDATE Snapshots SET validTo = ? WHERE resourceId = ? AND validFrom = ?`,
        validFrom, resourceId, current.meta.validFrom,
      );
    }

    // Insert new snapshot
    this.#ctx.storage.sql.exec(
      `INSERT INTO Snapshots (resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, eTag, changedBy, deleted, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      resourceId, nodeId, typeName, ontologyVersion, validFrom, END_OF_TIME, eTag, changedByJson, deleted ? 1 : 0, value,
    );
  }

  // ─── Public API ───────────────────────────────────────────────────

  read(resourceId: string): Snapshot | null {
    const snapshot = this.#getCurrentSnapshot(resourceId);
    if (!snapshot) return null;

    // Permission check — throws on failure
    this.#dagTree.requirePermission(snapshot.meta.nodeId, 'read');
    return snapshot;
  }

  /**
   * Enumerate the CURRENT resources of `typeName` whose to-one relationship
   * `field` equals `fieldValue` — the v1 `parentChild` query primitive (Child 2,
   * M1). Returns `{ resourceId, nodeId, validFrom }` ordered by
   * `(validFrom, resourceId)` (D15 — `validFrom` is server-stamped/chronological,
   * `resourceId` the deterministic tiebreaker for co-created rows).
   *
   * **No permission check here** — membership authorization happens at delivery
   * (the per-target `evaluatePermissions` in the membership-delivery routine);
   * each resource's CONTENT still requires a per-resource read on subscribe (D9).
   *
   * The FK is extracted in **JS from the structured-clone value at scan time**,
   * never `json_extract` over the blob — the query layer keys off the ontology
   * semantic model, not the storage serialization (D8). This is a full scan of the
   * type's current snapshots (the deferred D8 index swaps the WHERE/source here,
   * same signature); deleted + superseded rows are excluded.
   */
  enumerateCurrentByField(
    typeName: string,
    field: string,
    fieldValue: string,
  ): Array<{ resourceId: string; nodeId: number; validFrom: string }> {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, nodeId, validFrom, value
       FROM Snapshots
       WHERE typeName = ? AND validTo = ? AND deleted = 0
       ORDER BY validFrom, resourceId`,
      typeName, END_OF_TIME,
    ).toArray();

    const matches: Array<{ resourceId: string; nodeId: number; validFrom: string }> = [];
    for (const row of rows) {
      const value = parse(row.value as string);
      if (value != null && value[field] === fieldValue) {
        matches.push({
          resourceId: row.resourceId as string,
          nodeId: row.nodeId as number,
          validFrom: row.validFrom as string,
        });
      }
    }
    return matches;
  }

  async transaction(
    ops: Record<string, OperationDescriptor>,
    ontologyVersion: string,
    newETag: string,
    facet: ParserValidator,
    onMutations?: (mutations: Map<string, Snapshot>) => void,
  ): Promise<TransactionResult> {
    // Empty ops — no-op
    const entries = Object.entries(ops);
    if (entries.length === 0) return { ok: true, eTags: {} };

    // Validate resourceIds
    for (const [resourceId] of entries) {
      if (!resourceId) throw new Error('resourceId must not be empty');
    }

    // Step 1: Read current snapshots outside transaction (for validFrom calculation)
    const currentSnapshots = new Map<string, Snapshot | null>();
    for (const [resourceId] of entries) {
      currentSnapshots.set(resourceId, this.#getCurrentSnapshot(resourceId));
    }

    // Step 2: Calculate single validFrom
    const validFrom = this.#calculateValidFrom(currentSnapshots);

    // Step 3: Use the caller-supplied per-transaction eTag (one for the whole
    // batch). The client generates this so it can also serve as the
    // idempotency key — if a retry lands and every resource is already at
    // this eTag, Step 9 short-circuits to a `committed` result without
    // writing again.
    const eTag = newETag;

    // Step 4: Build changedBy from callContext
    const changedBy = this.#buildChangedBy();

    // Step 4.5: Monotonic pre-checks (before the validator). Run against
    // `currentSnapshots` (already read at Step 1 — no extra reads) so a doomed
    // or already-applied transaction skips the ~1.4 ms validator facet call.
    // They may ONLY act on a conclusion a concurrent commit can't reverse
    // between the Step-1 read and the txn: a replay (commit is irreversible)
    // and an eTag conflict (eTags are forward-only, so `current ≠ op.eTag`
    // stays true). Op-existence and permissions are NOT monotonic (a
    // concurrent create/grant could flip them), so they stay authoritative
    // inside transactionSync. Everything here is re-decided authoritatively in
    // the txn — optimization, not correctness. Only 4.5a may fast-fail
    // (early-return), and it discloses nothing but eTags. 4.5b deliberately
    // returns NOTHING to the caller: disclosing a snapshot must wait for the
    // Step-8 permission gate (an early conflict return carrying
    // `currentSnapshot` would hand any authenticated user a permission-free
    // read via a wrong-eTag put). Idempotency MUST precede the conflict scan:
    // a replay has `current.eTag === newETag` while `op.eTag` is the old
    // baseline, which the conflict scan would otherwise mis-flag.

    // Step 4.5a — Idempotency replay: any resource already at `newETag` means
    // this exact transaction committed (newETag is a fresh per-attempt UUID
    // written to the whole batch atomically at Step 10; `.some`, not `.every`,
    // so a sibling since-mutated by a third party doesn't hide the replay).
    if (entries.some(([resourceId]) => currentSnapshots.get(resourceId)?.meta.eTag === newETag)) {
      const eTags: Record<string, string> = {};
      for (const [resourceId] of entries) eTags[resourceId] = newETag;
      return { ok: true, eTags };
    }

    // Step 4.5b — eTag-conflict validation skip (a hint, never a verdict): a
    // present resource whose current eTag mismatches the op's baseline can't
    // revert, so it WILL conflict at Step 9 — skip its validator work (on the
    // use-this path the value gets superseded by the merge anyway). The
    // conflict verdict — and the `currentSnapshot` disclosure — happens ONLY
    // at Step 9, after the Step-8 permission gate. Skipping validation here is
    // also what makes conflict win over an invalid value when both co-occur on
    // one resource (its validation never runs). In a batch mixing a
    // conflict-suspect with an invalid SIBLING, the sibling's validation
    // failure still fails the batch first; the suspect's conflict surfaces on
    // the retry. Absent `current` (not-found) is deferred to the authoritative
    // Step 7; it isn't monotonic.
    const conflictSuspects = new Set<string>();
    for (const [resourceId, op] of entries) {
      if (op.op === 'create') continue;
      const current = currentSnapshots.get(resourceId);
      if (current && current.meta.eTag !== (op as { eTag?: string }).eTag) {
        conflictSuspects.add(resourceId);
      }
    }

    // Step 5: Parse + validate via facet (one batch call). `parse()` fills
    // `@default` values into a fresh object per item; on success we write
    // `result.data` back so downstream Step 7+ sees the filled value.
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
      const log = debug('nebula.Resources.transaction');
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
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        });
        throw err;
      }
      for (const [resourceId, result] of results) {
        if (result.valid) {
          const op = ops[resourceId];
          if (op.op === 'create' || op.op === 'put') {
            op.value = result.data;
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

    // Steps 6–10: Atomic transaction
    let result: TransactionResult = { ok: true, eTags: {} };
    const writtenSnapshots = new Map<string, Snapshot>();

    this.#ctx.storage.transactionSync(() => {
      // Step 6: Re-read inside transaction (authoritative for eTag checking)
      const authoritative = new Map<string, Snapshot | null>();
      for (const [resourceId] of entries) {
        authoritative.set(resourceId, this.#getCurrentSnapshot(resourceId));
      }

      // Step 6.5: Authoritative idempotency replay check. The Step-4.5a
      // pre-check catches most replays before the validator, but two retries
      // with the same newETag can interleave at the validator's await — the
      // first commits between this retry's Step-1 read and its Step-6 re-read,
      // so only the authoritative re-read here sees `newETag` and stops Step 7
      // from throwing "already exists" on a legitimate retry. Must run before
      // op-validation, permissions, and the eTag check (a landed write must not
      // be retroactively denied/conflicted on replay).
      if (entries.some(([resourceId]) => authoritative.get(resourceId)?.meta.eTag === newETag)) {
        const eTags: Record<string, string> = {};
        for (const [resourceId] of entries) eTags[resourceId] = newETag;
        result = { ok: true, eTags };
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
              this.#dagTree.requirePermission(op.nodeId, 'write');
              break;
            case 'put':
            case 'delete':
              this.#dagTree.requirePermission(current!.meta.nodeId, 'write');
              break;
            case 'move':
              this.#dagTree.requirePermission(current!.meta.nodeId, 'write');
              this.#dagTree.requirePermission(op.nodeId, 'write');
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

      // Step 9: Check eTags — conflicts produce { ok: false }. This is the
      // ONLY place a conflict is decided or a `currentSnapshot` disclosed —
      // deliberately AFTER the Step-8 permission gate (the Step-4.5b scan only
      // skips doomed validator work; it returns nothing to the caller). Runs
      // against the in-txn snapshot, so it also catches conflicts that
      // appeared during the validator's await and returns the freshest
      // currentSnapshot for the resolver. Idempotency replays already
      // returned at Step 6.5, so no resource here is at `newETag`.
      const errors: Record<string, TransactionError> = {};
      for (const [resourceId, op] of entries) {
        if (op.op === 'create') continue;
        const current = authoritative.get(resourceId)!;
        if (current.meta.eTag !== (op as any).eTag) {
          errors[resourceId] = { type: 'conflict', currentSnapshot: current };
        }
      }

      if (Object.keys(errors).length > 0) {
        result = { ok: false, errors };
        return; // Exit transactionSync — nothing written, automatic rollback
      }

      // Step 10: Write all changes
      const eTags: Record<string, string> = {};
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId) ?? null;

        // Move to same node — idempotent no-op (no write, no fanout)
        if (op.op === 'move' && current && op.nodeId === current.meta.nodeId) {
          eTags[resourceId] = current.meta.eTag;
          continue;
        }

        const typeName = op.op === 'create'
          ? op.typeName
          : authoritative.get(resourceId)!.meta.typeName;
        this.#writeSnapshot(resourceId, current, op, validFrom, eTag, changedBy, typeName, ontologyVersion);
        eTags[resourceId] = eTag;

        // Capture the post-write snapshot for fanout. Re-read inside the
        // transactionSync so the captured value matches what was actually
        // committed. Soft-delete carries `meta.deleted: true` — we pass the
        // real Snapshot, never null, per the user-facing decision in 5.3.1.
        const written = this.#getCurrentSnapshot(resourceId);
        if (written) writtenSnapshots.set(resourceId, written);
      }

      result = { ok: true, eTags };
    });

    if (result.ok && writtenSnapshots.size > 0 && onMutations) {
      onMutations(writtenSnapshots);
    }

    return result;
  }
}
