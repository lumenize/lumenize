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
import { stringify, parse } from '@lumenize/structured-clone';
import type { DagTree } from './dag-tree';

// ─── Constants ─────────────────────────────────────────────────────

export const END_OF_TIME = '9999-01-01T00:00:00.000Z';

// ─── Types ─────────────────────────────────────────────────────────

export interface SnapshotMeta {
  nodeId: number;
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
  | { op: 'create'; nodeId: number; value: any }
  | { op: 'update'; eTag: string; value: any }
  | { op: 'move';   eTag: string; nodeId: number }
  | { op: 'delete'; eTag: string };

export type TransactionResult =
  | { ok: true;  eTags: Record<string, string> }
  | { ok: false; conflicts: Record<string, Snapshot> };

// ─── Resources Class ───────────────────────────────────────────────

export class Resources {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #dagTree: DagTree;
  #onChanged: () => void;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    dagTree: DagTree,
    onChanged: () => void,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#dagTree = dagTree;
    this.#onChanged = onChanged;
    this.#createSchema();
    this.#bootstrapConfig();
  }

  // ─── Schema & Config ──────────────────────────────────────────────

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Snapshots (
        resourceId TEXT NOT NULL,
        nodeId INTEGER NOT NULL,
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
      `SELECT resourceId, nodeId, validFrom, validTo, eTag, changedBy, deleted, value
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
        eTag: row.eTag as string,
        validFrom: row.validFrom as string,
        validTo: row.validTo as string,
        changedBy: JSON.parse(row.changedBy as string) as ActClaim,
        deleted: Boolean(row.deleted),
      },
    };
  }

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
      case 'update':
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
           SET nodeId = ?, eTag = ?, changedBy = ?, deleted = ?, value = ?
           WHERE resourceId = ? AND validFrom = ?`,
          nodeId, eTag, changedByJson, deleted ? 1 : 0, value,
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
      `INSERT INTO Snapshots (resourceId, nodeId, validFrom, validTo, eTag, changedBy, deleted, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      resourceId, nodeId, validFrom, END_OF_TIME, eTag, changedByJson, deleted ? 1 : 0, value,
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

  transaction(ops: Record<string, OperationDescriptor>): TransactionResult {
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

    // Step 3: Generate single eTag
    const eTag = crypto.randomUUID();

    // Step 4: Build changedBy from callContext
    const changedBy = this.#buildChangedBy();

    // Step 5–11: Atomic transaction
    let result: TransactionResult = { ok: true, eTags: {} };

    this.#ctx.storage.transactionSync(() => {
      // Step 6: Re-read inside transaction (authoritative for eTag checking)
      const authoritative = new Map<string, Snapshot | null>();
      for (const [resourceId] of entries) {
        authoritative.set(resourceId, this.#getCurrentSnapshot(resourceId));
      }

      // Step 7: Validate operations
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId)!;

        if (op.op === 'create') {
          if (current) {
            throw new Error(`Resource '${resourceId}' already exists — use update instead`);
          }
          if (op.value == null) {
            throw new Error(`Value must not be null or undefined for create on '${resourceId}'`);
          }
        } else {
          // update, move, delete — resource must exist
          if (!current) {
            throw new Error(`Resource '${resourceId}' not found`);
          }
          if (op.op === 'update' && op.value == null) {
            throw new Error(`Value must not be null or undefined for update on '${resourceId}'`);
          }
        }
      }

      // Step 8: Permission checks
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId) ?? null;
        switch (op.op) {
          case 'create':
            this.#dagTree.requirePermission(op.nodeId, 'write');
            break;
          case 'update':
          case 'delete':
            this.#dagTree.requirePermission(current!.meta.nodeId, 'write');
            break;
          case 'move':
            this.#dagTree.requirePermission(current!.meta.nodeId, 'write');
            this.#dagTree.requirePermission(op.nodeId, 'write');
            break;
        }
      }

      // Step 9: Check eTags — conflicts produce { ok: false }
      const conflicts: Record<string, Snapshot> = {};
      for (const [resourceId, op] of entries) {
        if (op.op === 'create') continue;
        const current = authoritative.get(resourceId)!;
        if (current.meta.eTag !== (op as any).eTag) {
          conflicts[resourceId] = current;
        }
      }

      if (Object.keys(conflicts).length > 0) {
        result = { ok: false, conflicts };
        return; // Exit transactionSync — nothing written, automatic rollback
      }

      // Step 10: Write all changes
      const eTags: Record<string, string> = {};
      for (const [resourceId, op] of entries) {
        const current = authoritative.get(resourceId) ?? null;

        // Move to same node — idempotent no-op
        if (op.op === 'move' && current && op.nodeId === current.meta.nodeId) {
          eTags[resourceId] = current.meta.eTag;
          continue;
        }

        this.#writeSnapshot(resourceId, current, op, validFrom, eTag, changedBy);
        eTags[resourceId] = eTag;
      }

      result = { ok: true, eTags };
    });

    if (result.ok) {
      this.#onChanged();
    }

    return result;
  }
}
