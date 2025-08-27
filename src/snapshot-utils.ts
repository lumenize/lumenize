/**
 * Utility functions for working with entity snapshots
 */

// Constants for temporal versioning
export const CURRENT_SNAPSHOT_VALID_TO = '9999-01-01T00:00:00.000Z';

// Public fields to return in responses (excludes previousValues for security/privacy)
export const PUBLIC_FIELDS = [
  'entityId',
  'validFrom', 
  'validTo',
  'changedBy',
  'value',
  'deleted',
  'parentId',
  'entityTypeName',
  'entityTypeVersion'
] as const;

// Private fields that should only be accessed in internal operations
export const PRIVATE_FIELDS = [
  'previousValues'
] as const;

export interface Snapshot {
  entityId: string;
  validFrom: string;
  validTo: string;
  changedBy: string;
  previousValues: string;
  value: string;
  deleted: boolean;
  parentId: string | null;
  entityTypeName: string;
  entityTypeVersion: string;
}

/**
 * Get the current snapshot for an entity (the one with validTo = CURRENT_SNAPSHOT_VALID_TO)
 */
export function getCurrentSnapshot(
  storage: DurableObjectStorage, 
  entityId: string,
): Snapshot | null {
  const results = storage.sql.exec(`
    SELECT ${[...PUBLIC_FIELDS, ...PRIVATE_FIELDS].join(', ')}
    FROM snapshots 
    WHERE entityId = ? AND validTo = ?
  `, entityId, CURRENT_SNAPSHOT_VALID_TO).toArray();
  
  if (results.length === 0) {
    return null;
  }
  
  const snapshot = results[0] as any;
  // Convert SQLite integer back to boolean for easier handling
  return {
    ...snapshot,
    deleted: Boolean(snapshot.deleted)
  } as Snapshot;
}

/**
 * Get the current snapshot for an entity with only public fields
 * Used by read operations for security/privacy
 */
export function getCurrentSnapshotPublic(
  storage: DurableObjectStorage, 
  entityId: string,
): Snapshot | null {
  const results = storage.sql.exec(`
    SELECT ${PUBLIC_FIELDS.join(', ')}
    FROM snapshots 
    WHERE entityId = ? AND validTo = ?
  `, entityId, CURRENT_SNAPSHOT_VALID_TO).toArray();
  
  if (results.length === 0) {
    return null;
  }
  
  const snapshot = results[0] as any;
  // Convert SQLite integer back to boolean for easier handling
  return {
    ...snapshot,
    deleted: Boolean(snapshot.deleted)
  } as Snapshot;
}

/**
 * Get current timestamp as ISO string
 * Common utility used across entity operations
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Validate temporal range parameters
 * Ensures validTo is greater than validFrom and both are valid ISO timestamps
 */
export function validateTemporalRange(validFrom: string, validTo: string): void {
  const fromDate = new Date(validFrom);
  const toDate = new Date(validTo);
  
  if (isNaN(fromDate.getTime())) {
    throw new Error('validFrom must be a valid ISO timestamp');
  }
  
  if (isNaN(toDate.getTime())) {
    throw new Error('validTo must be a valid ISO timestamp');
  }
  
  // Use string comparison for efficiency since ISO 8601 strings are lexicographically sortable
  if (validTo <= validFrom) {
    throw new Error('validTo must be greater than validFrom');
  }
}
