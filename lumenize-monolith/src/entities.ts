import type { Tool } from './tool-registry';
import { Validator } from '@cfworker/json-schema';
import { ResourceTemplate, ListResourceTemplatesResult } from './schema/draft/schema';
import { UpsertEntity } from './entity-upsert';
import { DeleteEntity, UndeleteEntity } from './entity-delete';
import { EntityTypes, EntityTypeDefinition } from './entity-types';
import { EntitySubscriptions, JSONRPCSubscriptionResponse, JSONRPCUnsubscriptionResponse } from './entity-subscriptions';
import { ReadEntity } from './entity-read';
import { ReadResourceResult } from './schema/draft/schema';
import { EntityUriRouter } from './entity-uri-router';
import { NotificationService } from './notification-service';

export class Entities {
  readonly #entityTypes: EntityTypes;
  readonly #storage: DurableObjectStorage;
  readonly #uriRouter: EntityUriRouter;
  readonly #upsertEntity: UpsertEntity;
  readonly #deleteEntity: DeleteEntity;
  readonly #undeleteEntity: UndeleteEntity;
  readonly #subscriptions: EntitySubscriptions;
  readonly #readEntity: ReadEntity;

  constructor(storage: DurableObjectStorage, notificationService: NotificationService, uriRouter: EntityUriRouter) {
    this.#entityTypes = new EntityTypes(storage);
    this.#storage = storage;
    
    // Use the shared URI router instance passed from LumenizeServer
    this.#uriRouter = uriRouter;
    
    // Initialize the SQLite table for temporal entity storage
    this.#initializeDatabase();
    
    // Initialize entity management functionality with shared URI router and notification service
    this.#upsertEntity = new UpsertEntity(storage, this, this.#uriRouter, notificationService);
    this.#deleteEntity = new DeleteEntity(storage, this, notificationService);
    this.#undeleteEntity = new UndeleteEntity(storage, this, notificationService);
    this.#readEntity = new ReadEntity(storage, this, this.#uriRouter);
    this.#subscriptions = new EntitySubscriptions(storage, this.#readEntity, this.#uriRouter);
    
    // Initialize subscriptions table schema
    this.#subscriptions.init();
  }

  #initializeDatabase(): void {
    // Create the entities table with temporal columns using Richard Snodgrass temporal model
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        entityId TEXT NOT NULL,
        validFrom TEXT NOT NULL,
        validTo TEXT NOT NULL,
        changedBy TEXT NOT NULL,
        previousValues TEXT NOT NULL,
        value TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        parentId TEXT NOT NULL,
        entityTypeName TEXT NOT NULL,
        entityTypeVersion INTEGER NOT NULL,
        PRIMARY KEY (entityId, validFrom)
      )
    `);

    // Create filtered index for efficient lookup of latest snapshot
    this.#storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_latest 
      ON snapshots (entityId, deleted)
      WHERE validTo = '9999-01-01T00:00:00.000Z'
    `);

    // Create filtered index for efficient hierarchy queries of the current state
    this.#storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_hierarchy 
      ON snapshots (parentId, deleted)
      WHERE validTo = '9999-01-01T00:00:00.000Z'
    `);
  }

  getEntityTypeDefinition(name: string, version: number): EntityTypeDefinition | undefined {
    return this.#entityTypes.getEntityTypeDefinition(name, version);
  }

  getLatestEntityTypeDefinition(name: string): EntityTypeDefinition | undefined {
    return this.#entityTypes.getLatestEntityTypeDefinition(name);
  }

  addEntityTypeDefinition(definition: EntityTypeDefinition): void {
    this.#entityTypes.addEntityTypeDefinition(definition);
  }

  getAddEntityTypeTool(): Tool {
    return this.#entityTypes.createTool();
  }

  getReadEntity(): ReadEntity {
    return this.#readEntity;
  }

  getUpsertEntityTool(): Tool {
    return this.#upsertEntity.createTool();
  }

  getDeleteEntityTool(): Tool {
    return this.#deleteEntity.createTool();
  }

  getUndeleteEntityTool(): Tool {
    return this.#undeleteEntity.createTool();
  }

  listEntityTypeDefinitions(): EntityTypeDefinition[] {
    return this.#entityTypes.listEntityTypeDefinitions();
  }

  /**
   * Validates and parses a data object against an entity type schema in the registry
   * @param name
   * @param version
   * @param value - The value as a JSON string or an object
   * @returns the parsed object if valid, throws error if invalid or schema not found
   */
  parseEntity(name: string, version: number, valueStringOrObject: string | object ): object {
    const definition = this.#entityTypes.getEntityTypeDefinition(name, version);
    if (!definition) {
      throw new Error(`EntityTypeDefinition with name '${name}' and version '${version}' does not exist`);
    }
    let value: any;
    if (typeof valueStringOrObject === 'string') {
      try {
        value = JSON.parse(valueStringOrObject);
      } catch (e: any) {
        throw new TypeError(`Invalid JSON string: ${e.message}`);
      }
    } else if (typeof valueStringOrObject === 'object') {
      value = valueStringOrObject;
    } else {
      throw new TypeError("Value must be a JSON string or an object");
    }
    const validator = new Validator(definition.jsonSchema, '2020-12', false);
    const validationResult = validator.validate(value);
    
    if (!validationResult.valid) {
      // Collect all validation errors into a readable message
      const errors = validationResult.errors.map(error => {
        return error.error ?? 'Validation failed';
      }).join('; ');

      throw new TypeError(`Invalid value for EntityTypeDefinition '${name}' version '${version}': ${errors}`);
    }

    return value;
  }

  /**
   * Generate resource templates from entity types for MCP protocol
   * @param cursor - Optional pagination cursor (not implemented yet)
   * @returns Resource templates result for MCP
   */
  getResourceTemplates(cursor?: string): ListResourceTemplatesResult {
    // For now, we don't implement pagination, but we could validate cursor if provided
    if (cursor) {
      console.warn('Pagination cursor provided but not implemented:', cursor);
    }
    
    // Generate resource templates using centralized URI router
    const allTemplates: ResourceTemplate[] = [];
    
    // Add entity registry template first
    const entityRegistryTemplate = this.#uriRouter.getEntityRegistryResourceTemplate(
      'lumenize', 'default', 'default', 'default'
    );
    allTemplates.push(entityRegistryTemplate);
    
    // Get the four generic entity templates (no longer per-entity-type)
    const genericTemplates = this.#uriRouter.getResourceTemplates();
    allTemplates.push(...genericTemplates);
    
    return {
      resourceTemplates: allTemplates
    };
  }

  /**
   * Subscribe a connection to resource updates for a specific entity
   * @param subscriberId - Unique subscriber identifier (per connection/tab)
   * @param uri - MCP resource URI
   * @param requestId - Optional request ID for MCP response
   * @param initialBaseline - Optional initial baseline for patch subscriptions
   * @returns Promise that resolves with subscription confirmation in same format as resources/read
   */
  subscribeToResource(subscriberId: string, uri: string, requestId?: string | number, initialBaseline?: string): ReadResourceResult | JSONRPCSubscriptionResponse {
    return this.#subscriptions.subscribe(subscriberId, uri, requestId, initialBaseline);
  }

  /**
   * Unsubscribe a connection from resource updates for a specific entity
   * @param subscriberId - Unique subscriber identifier (per connection/tab)
   * @param uri - MCP resource URI
   * @param requestId - Optional request ID for MCP response
   * @returns Promise that resolves with unsubscription confirmation
   */
  unsubscribeFromResource(subscriberId: string, uri: string, requestId?: string | number): { unsubscribed: true; uri: string } | JSONRPCUnsubscriptionResponse {
    return this.#subscriptions.unsubscribe(subscriberId, uri, requestId);
  }

  /**
   * Remove all subscriptions for a specific subscriber (e.g., when connection closes)
   * @param subscriberId - Unique subscriber identifier
   */
  removeAllSubscriptionsForSubscriber(subscriberId: string): void {
    return this.#subscriptions.removeAllSubscriptionsForSubscriber(subscriberId);
  }

}
