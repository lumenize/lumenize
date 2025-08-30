import type { Tool } from './tool-registry';
import { EntityNotFoundError } from './errors';
import { getCurrentSnapshot, CURRENT_SNAPSHOT_VALID_TO, getCurrentTimestamp } from './snapshot-utils';
import { CHANGED_BY_SCHEMA, type ChangedBy } from './changed-by-schema';
import type { Entities } from './entities';
import type { NotificationService } from './notification-service';

export class DeleteEntity {

  static readonly tool: Omit<Tool, 'handler'> = {
    name: 'delete-entity',
    description: 'Soft delete an entity with temporal versioning',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { 
          type: 'string', 
          description: 'The unique identifier for the entity' 
        },
        changedBy: CHANGED_BY_SCHEMA
      },
      required: ['entityId', 'changedBy']
    },
    outputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The entity identifier' },
        success: { type: 'boolean', description: 'Whether the entity was successfully deleted' },
        validFrom: { type: 'string', description: 'ISO timestamp when this version becomes valid' },
        validTo: { type: 'string', description: 'ISO timestamp when this version becomes invalid' }
      },
      required: ['entityId', 'success', 'validFrom', 'validTo']
    },
    annotations: {
      title: 'Delete Entity',
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
  };

  readonly #storage: DurableObjectStorage;
  readonly #entities: Entities;
  readonly #notificationService: NotificationService;

  constructor(
    storage: DurableObjectStorage,
    entities: Entities,
    notificationService: NotificationService
  ) {
    this.#storage = storage;
    this.#entities = entities;
    this.#notificationService = notificationService;
  }

  createTool(): Tool {
    return {
      ...DeleteEntity.tool,
      handler: (args) => this.#handleDelete(args)
    };
  }

  #handleDelete(args: any) {
    const { 
      entityId, 
      changedBy
    } = args ?? {};
    
    // Get current snapshot first to check entity state
    const currentSnapshot = getCurrentSnapshot(this.#storage, entityId);

    // Check if entity exists
    if (!currentSnapshot) {
      throw new EntityNotFoundError(`Entity with ID '${entityId}' not found`);
    }

    // Check if entity is already deleted (idempotent operation)
    if (currentSnapshot.deleted) {
      return {
        entityId,
        success: true,
        validFrom: currentSnapshot.validFrom,
        validTo: currentSnapshot.validTo,
        changedBy: currentSnapshot.changedBy ? JSON.parse(currentSnapshot.changedBy) : [],
        value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
        deleted: true,
        parentId: currentSnapshot.parentId,
        entityTypeName: currentSnapshot.entityTypeName,
        entityTypeVersion: currentSnapshot.entityTypeVersion
      };
    }

    // Set timestamps - always use current time for validFrom and default for validTo
    let newSnapshotValidFrom = getCurrentTimestamp();
    const newSnapshotValidTo = CURRENT_SNAPSHOT_VALID_TO;

    // Every snapshot must have a unique and monotonically increasing validFrom timestamp
    if (currentSnapshot.validFrom >= newSnapshotValidFrom) {
      // Add 1ms to avoid collision
      newSnapshotValidFrom = new Date(new Date(currentSnapshot.validFrom).getTime() + 1).toISOString();
    }

    // Value remains unchanged during delete, previousValues is empty since we're not changing the value
    const previousValues = {}; // Empty since value doesn't change during delete

    // Update the old snapshot's validTo to avoid primary key conflict
    this.#storage.sql.exec(`
      UPDATE snapshots 
      SET validTo = ? 
      WHERE entityId = ? AND validTo = ?
    `, newSnapshotValidFrom, entityId, CURRENT_SNAPSHOT_VALID_TO);

    // Insert new snapshot with deleted=true
    this.#storage.sql.exec(`
      INSERT INTO snapshots (entityId, validFrom, validTo, changedBy, previousValues, value, deleted, parentId, entityTypeName, entityTypeVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 
      entityId,
      newSnapshotValidFrom,
      newSnapshotValidTo,
      JSON.stringify(changedBy),  // Serialize changedBy since it can be JSON
      JSON.stringify(previousValues),  // Empty object for deletes
      currentSnapshot.value,  // Use original string value directly
      1,  // Store true as 1 for SQLite (deleted=true)
      currentSnapshot.parentId,
      currentSnapshot.entityTypeName,
      currentSnapshot.entityTypeVersion
    );

    // Send notifications to subscribers with the deleted entity data
    this.#notificationService.sendEntityUpdateNotification(entityId, {
      entityId,
      validFrom: newSnapshotValidFrom,
      validTo: newSnapshotValidTo,
      changedBy,
      value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
      deleted: true,
      parentId: currentSnapshot.parentId,
      entityTypeName: currentSnapshot.entityTypeName,
      entityTypeVersion: currentSnapshot.entityTypeVersion
    });

    return {
      entityId,
      success: true,
      validFrom: newSnapshotValidFrom,
      validTo: newSnapshotValidTo,
      changedBy,
      value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
      deleted: true,
      parentId: currentSnapshot.parentId,
      entityTypeName: currentSnapshot.entityTypeName,
      entityTypeVersion: currentSnapshot.entityTypeVersion
    };
  }
}

export class UndeleteEntity {

  static readonly tool: Omit<Tool, 'handler'> = {
    name: 'undelete-entity',
    description: 'Restore a soft deleted entity with temporal versioning',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { 
          type: 'string', 
          description: 'The unique identifier for the entity' 
        },
        changedBy: CHANGED_BY_SCHEMA
      },
      required: ['entityId', 'changedBy']
    },
    outputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The entity identifier' },
        success: { type: 'boolean', description: 'Whether the entity was successfully undeleted' },
        validFrom: { type: 'string', description: 'ISO timestamp when this version becomes valid' },
        validTo: { type: 'string', description: 'ISO timestamp when this version becomes invalid' }
      },
      required: ['entityId', 'success', 'validFrom', 'validTo']
    },
    annotations: {
      title: 'Undelete Entity',
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
  };

  readonly #storage: DurableObjectStorage;
  readonly #entities: Entities;
  readonly #notificationService: NotificationService;

  constructor(
    storage: DurableObjectStorage,
    entities: Entities,
    notificationService: NotificationService
  ) {
    this.#storage = storage;
    this.#entities = entities;
    this.#notificationService = notificationService;
  }

  createTool(): Tool {
    return {
      ...UndeleteEntity.tool,
      handler: (args) => this.#handleUndelete(args)
    };
  }

  #handleUndelete(args: any) {
    const { 
      entityId, 
      changedBy
    } = args ?? {};
    
    // Get current snapshot first to check entity state
    const currentSnapshot = getCurrentSnapshot(this.#storage, entityId);

    // Check if entity exists
    if (!currentSnapshot) {
      throw new EntityNotFoundError(`Entity with ID '${entityId}' not found`);
    }

    // Check if entity is already not deleted (idempotent operation)
    if (!currentSnapshot.deleted) {
      return {
        entityId,
        success: true,
        validFrom: currentSnapshot.validFrom,
        validTo: currentSnapshot.validTo,
        changedBy: currentSnapshot.changedBy ? JSON.parse(currentSnapshot.changedBy) : [],
        value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
        deleted: false,
        parentId: currentSnapshot.parentId,
        entityTypeName: currentSnapshot.entityTypeName,
        entityTypeVersion: currentSnapshot.entityTypeVersion
      };
    }

    // Set timestamps - always use current time for validFrom and default for validTo
    let newSnapshotValidFrom = getCurrentTimestamp();
    const newSnapshotValidTo = CURRENT_SNAPSHOT_VALID_TO;

    // Every snapshot must have a unique and monotonically increasing validFrom timestamp
    if (currentSnapshot.validFrom >= newSnapshotValidFrom) {
      // Add 1ms to avoid collision
      newSnapshotValidFrom = new Date(new Date(currentSnapshot.validFrom).getTime() + 1).toISOString();
    }

    // Value remains unchanged during undelete, previousValues is empty since we're not changing the value
    const previousValues = {}; // Empty since value doesn't change during undelete

    // Update the old snapshot's validTo to end at the moment the new snapshot starts
    const oldSnapshotNewValidTo = newSnapshotValidFrom;

    // Update the old snapshot's validTo to avoid primary key conflict
    this.#storage.sql.exec(`
      UPDATE snapshots 
      SET validTo = ? 
      WHERE entityId = ? AND validTo = ?
    `, oldSnapshotNewValidTo, entityId, CURRENT_SNAPSHOT_VALID_TO);

    // Insert new snapshot with deleted=false
    this.#storage.sql.exec(`
      INSERT INTO snapshots (entityId, validFrom, validTo, changedBy, previousValues, value, deleted, parentId, entityTypeName, entityTypeVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 
      entityId,
      newSnapshotValidFrom,
      newSnapshotValidTo,  // This should always be CURRENT_SNAPSHOT_VALID_TO
      JSON.stringify(changedBy),  // Serialize changedBy since it can be JSON
      JSON.stringify(previousValues),  // Empty object for undeletes
      currentSnapshot.value,  // Use original string value directly
      0,  // Store false as 0 for SQLite (deleted=false)
      currentSnapshot.parentId,
      currentSnapshot.entityTypeName,
      currentSnapshot.entityTypeVersion
    );

    // Send notifications to subscribers with the undeleted entity data
    this.#notificationService.sendEntityUpdateNotification(entityId, {
      entityId,
      validFrom: newSnapshotValidFrom,
      validTo: newSnapshotValidTo,
      changedBy,
      value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
      deleted: false,
      parentId: currentSnapshot.parentId,
      entityTypeName: currentSnapshot.entityTypeName,
      entityTypeVersion: currentSnapshot.entityTypeVersion
    });

    return {
      entityId,
      success: true,
      validFrom: newSnapshotValidFrom,
      validTo: newSnapshotValidTo,
      changedBy,
      value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
      deleted: false,
      parentId: currentSnapshot.parentId,
      entityTypeName: currentSnapshot.entityTypeName,
      entityTypeVersion: currentSnapshot.entityTypeVersion
    };
  }
}
