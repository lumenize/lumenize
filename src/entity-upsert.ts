import type { Tool } from './tool-registry';
import { ParameterValidationError } from './errors';
import type { Entities } from './entities';
import * as jsonmergepatch from './json-merge-patch';
import { getCurrentSnapshot, CURRENT_SNAPSHOT_VALID_TO, getCurrentTimestamp, validateTemporalRange } from './snapshot-utils';
import { CHANGED_BY_SCHEMA, type ChangedBy } from './changed-by-schema';
import { EntityUriRouter } from './entity-uri-router';
import type { NotificationService } from './notification-service';

export class UpsertEntity {

  static readonly tool: Omit<Tool, 'handler'> = {
    name: 'upsert-entity',
    description: 'Create or update an entity with temporal versioning',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { 
          type: 'string', 
          description: 'The unique identifier for the entity' 
        },
        entityTypeName: { 
          type: 'string', 
          description: 'The name of the entity type' 
        },
        entityTypeVersion: { 
          type: 'integer',
          minimum: 1, 
          description: 'The version number of the entity type (positive integer)' 
        },
        value: { 
          description: 'The complete entity value (mutually exclusive with patch)' 
        },
        patch: { 
          description: 'RFC-7396 merge patch to apply to existing entity (mutually exclusive with value)' 
        },
        changedBy: CHANGED_BY_SCHEMA,
        parentId: { 
          type: 'string', 
          description: 'Parent identifier for grouping related entities' 
        },
        validFrom: { 
          type: 'string', 
          description: 'ISO timestamp when this version becomes valid (optional, defaults to current time)' 
        },
        validTo: { 
          type: 'string', 
          description: 'ISO timestamp when this version becomes invalid (optional, defaults to end of time, must be provided if validFrom is provided)' 
        },
        baseline: {
          type: 'string',
          description: 'Baseline timestamp for patch-based updates (required when using patch to ensure patch is based on latest version)'
        }
      },
      required: ['entityId', 'entityTypeName', 'entityTypeVersion', 'changedBy']
    },
    outputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The entity identifier' },
        success: { type: 'boolean', description: 'Whether the entity was successfully upserted' },
        validFrom: { type: 'string', description: 'ISO timestamp when this version becomes valid' },
        validTo: { type: 'string', description: 'ISO timestamp when this version becomes invalid' }
      },
      required: ['entityId', 'success', 'validFrom', 'validTo']
    },
    annotations: {
      title: 'Upsert Entity',
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
  };

  readonly #storage: DurableObjectStorage;
  readonly #entities: Entities;
  readonly #uriRouter: EntityUriRouter;
  readonly #notificationService: NotificationService;

  constructor(
    storage: DurableObjectStorage,
    entities: Entities,
    uriRouter: EntityUriRouter,
    notificationService: NotificationService
  ) {
    this.#storage = storage;
    this.#entities = entities;
    this.#uriRouter = uriRouter;
    this.#notificationService = notificationService;
  }

  createTool(): Tool {
    return {
      ...UpsertEntity.tool,
      handler: (args) => this.#handleUpsert(args)
    };
  }

  #handleUpsert(args: any) {
    const { 
      entityId, 
      entityTypeName, 
      entityTypeVersion, 
      value, 
      patch, 
      changedBy, 
      parentId, 
      validFrom, 
      validTo,
      baseline
    } = args ?? {};
    
    // Validate that either value or patch is provided, but not both
    if (!value && !patch) {
      throw new ParameterValidationError('Either value or patch must be provided');
    }
    if (value && patch) {
      throw new ParameterValidationError('Cannot provide both value and patch');
    }

    // Handle baseline parameter for merge patches
    if (patch) {
      if (!baseline) {
        throw new ParameterValidationError('baseline is required when using patch');
      }
    }

    // Validate temporal parameters
    if ((validFrom && !validTo) || (!validFrom && validTo)) {
      throw new ParameterValidationError('If validFrom or validTo is provided, both must be provided');
    }

    // Set default timestamps if not provided
    let newSnapshotValidFrom = validFrom ?? getCurrentTimestamp();
    const newSnapshotValidTo = validTo ?? CURRENT_SNAPSHOT_VALID_TO;

    // Get current snapshot
    const currentSnapshot = getCurrentSnapshot(this.#storage, entityId);

    // Validate parentId is provided for new entities
    if (!currentSnapshot && !parentId) {
      throw new ParameterValidationError('parentId is required when creating a new entity');
    }

    // Every snapshot must have a unique and monotonically increasing validFrom timestamp
    if (currentSnapshot && currentSnapshot.validFrom >= newSnapshotValidFrom) {
      // Add 1ms to avoid collision
      newSnapshotValidFrom = new Date(new Date(currentSnapshot.validFrom).getTime() + 1).toISOString();
    }

    // Validate temporal range
    validateTemporalRange(newSnapshotValidFrom, newSnapshotValidTo);

    let finalValue: any;
    let previousValues: any = {};

    if (currentSnapshot) {
      // Entity exists - handle update
      
      // If using patch, validate that baseline timestamp matches the current snapshot
      if (patch && baseline !== currentSnapshot.validFrom) {
        throw new ParameterValidationError(
          `Baseline (${baseline}) does not match the latest snapshot's validFrom (${currentSnapshot.validFrom}). The patch may be based on an outdated version.`
        );
      }
      
      const oldValue = JSON.parse(currentSnapshot.value);  // TODO: Investigate if we can let Cloudflare SQLite do the parsing
      
      if (patch) {
        finalValue = jsonmergepatch.apply(structuredClone(oldValue), patch);
      } else {
        finalValue = value;
      }

      // Generate reverse merge patch for previousValues (patch to go from finalValue back to oldValue)
      previousValues = jsonmergepatch.generate(finalValue, oldValue);
      
      // If no changes were made (null or empty object), return early for idempotency
      if (previousValues == null || (typeof previousValues === 'object' && Object.keys(previousValues).length === 0)) {
        return {
          entityId,
          success: true,
          validFrom: currentSnapshot.validFrom,
          validTo: currentSnapshot.validTo,
          changedBy: currentSnapshot.changedBy ? JSON.parse(currentSnapshot.changedBy) : [],
          value: currentSnapshot.value ? JSON.parse(currentSnapshot.value) : null,
          deleted: Boolean(currentSnapshot.deleted),
          parentId: currentSnapshot.parentId,
          entityTypeName: currentSnapshot.entityTypeName,
          entityTypeVersion: currentSnapshot.entityTypeVersion
        };
      }

      // Update the old snapshot's validTo to avoid primary key conflict
      this.#storage.sql.exec(`
        UPDATE snapshots 
        SET validTo = ? 
        WHERE entityId = ? AND validTo = ?
      `, newSnapshotValidFrom, entityId, CURRENT_SNAPSHOT_VALID_TO);
    } else {
      // New entity - first snapshot
      finalValue = value ?? patch;
      previousValues = {};
    }

    // Validate that the provided entity type version is the latest version
    const latestEntityType = this.#entities.getLatestEntityTypeDefinition(entityTypeName);
    if (!latestEntityType) {
      throw new ParameterValidationError(`Entity type '${entityTypeName}' does not exist`);
    }
    if (entityTypeVersion !== latestEntityType.version) {
      throw new ParameterValidationError(
        `Entity type version '${entityTypeVersion}' is not the latest version. Latest version is '${latestEntityType.version}'. Only the latest version is accepted for upserts.`
      );
    }

    // Validate and parse the final value against the entity type schema (parse don't validate)
    finalValue = this.#entities.parseEntity(entityTypeName, entityTypeVersion, finalValue);

    // Insert new snapshot
    this.#storage.sql.exec(`
      INSERT INTO snapshots (entityId, validFrom, validTo, changedBy, previousValues, value, deleted, parentId, entityTypeName, entityTypeVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, 
      entityId,
      newSnapshotValidFrom,
      newSnapshotValidTo,
      JSON.stringify(changedBy),  // Serialize changedBy since it can be JSON
      JSON.stringify(previousValues),  // TODO: Can we just let Cloudflare SQLite stringify?
      JSON.stringify(finalValue),  // TODO: Can we just let Cloudflare SQLite stringify?
      0,  // Store false as 0 for SQLite
      parentId ?? currentSnapshot?.parentId,
      entityTypeName,
      entityTypeVersion
    );

    // Send notifications to subscribers with the updated entity data
    // Pass the oldValue (previous snapshot) and its validFrom timestamp to avoid database query in notification service
    this.#notificationService.sendEntityUpdateNotification(
      entityId, 
      {
        entityId,
        validFrom: newSnapshotValidFrom,
        validTo: newSnapshotValidTo,
        changedBy,
        value: finalValue,
        deleted: false,
        parentId: parentId ?? currentSnapshot?.parentId,
        entityTypeName,
        entityTypeVersion
      },
      currentSnapshot ? JSON.parse(currentSnapshot.value) : undefined, // Pass previous value to avoid DB query
      currentSnapshot ? currentSnapshot.validFrom : undefined // Pass baseline for patch baseline confirmation
    );

    return {
      entityId,
      success: true,
      validFrom: newSnapshotValidFrom,
      validTo: newSnapshotValidTo,
      changedBy,
      value: finalValue,
      deleted: false,
      parentId: parentId ?? currentSnapshot?.parentId,
      entityTypeName,
      entityTypeVersion
    };
  }
}
