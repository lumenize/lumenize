// @ts-ignore - uri-template-router doesn't have types
import { ReadEntity } from './entity-read';
import { ParameterValidationError } from './errors';
import { ReadResourceResult } from './schema/draft/schema';
import { 
  EntityUriRouter, 
  UriTemplateType, 
  type EntityUriParams 
} from './entity-uri-router';

// Type definitions for Router
interface RouteMatch<T = any> {
  params: T;
}

interface RouterInstance {
  addTemplate(name: string, template: string): void;
  match(uri: string): RouteMatch<EntityUriParams> | null;
}

export interface JSONRPCSubscriptionResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: ReadResourceResult;
}

export interface JSONRPCUnsubscriptionResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: {
    unsubscribed: true;
    uri: string;
  };
}

export class EntitySubscriptions {
  readonly #storage: DurableObjectStorage;
  readonly #uriRouter: EntityUriRouter;
  readonly #readEntity: ReadEntity;

  constructor(storage: DurableObjectStorage, readEntity: ReadEntity, uriRouter: EntityUriRouter) {
    this.#storage = storage;
    this.#uriRouter = uriRouter;
    this.#readEntity = readEntity;
  }

  /**
   * Initialize the subscriptions table with proper schema
   * This ensures patch and regular subscriptions can coexist
   */
  init(): void {
    // Drop existing table to ensure schema changes are applied (safe since not in production)
    this.#storage.sql.exec(`DROP TABLE IF EXISTS subscriptions`);
    
    // Create subscriptions table with (subscriberId, entityId, subscriptionType) as primary key
    // This allows multiple subscription types per entity per subscriber (regular vs patch)
    this.#storage.sql.exec(`
      CREATE TABLE subscriptions (
        subscriberId TEXT NOT NULL,
        entityId TEXT NOT NULL,
        subscriptionType TEXT NOT NULL,
        originalUri TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        PRIMARY KEY (subscriberId, entityId, subscriptionType)
      )
    `);

    // Create index for efficient subscription lookups by entityId
    this.#storage.sql.exec(`
      CREATE INDEX idx_subscriptions_entity 
      ON subscriptions (entityId)
    `);
  }

  /**
   * Parse entity URI and extract parameters
   * @param uri - MCP resource URI
   * @returns Parsed URI parameters or null if URI doesn't match or doesn't have entity ID
   */
  #parseEntityUri(uri: string): EntityUriParams | null {
    try {
      const parsed = this.#uriRouter.parseEntityUri(uri);
      // Ensure we only return EntityUriParams (those that have an 'id' property)
      const params = parsed.params as EntityUriParams;
      if (!params.id) {
        return null; // Registry URIs don't have entity IDs
      }
      return params;
    } catch {
      return null;
    }
  }

  /**
   * Subscribe a connection to resource updates for a specific entity
   * @param subscriberId - Unique subscriber identifier (per connection/tab)
   * @param uri - MCP resource URI
   * @param requestId - Optional request ID for MCP response
   * @param initialBaseline - Optional initial baseline for patch subscriptions
   * @returns Promise that resolves with subscription confirmation in same format as resources/read
   */
  subscribe(subscriberId: string, uri: string, requestId?: string | number, initialBaseline?: string): ReadResourceResult | JSONRPCSubscriptionResponse {
    // Parse and validate URI
    let parsedUri;
    try {
      parsedUri = this.#uriRouter.parseEntityUri(uri);
    } catch (error) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    // Validate URI type - only current entity and patch subscription URIs support subscriptions
    if (parsedUri.type !== UriTemplateType.CURRENT_ENTITY && parsedUri.type !== UriTemplateType.PATCH_SUBSCRIPTION) {
      throw new ParameterValidationError(`Subscriptions not supported for URI type: ${parsedUri.type}`);
    }

    // Validate initialBaseline timestamp format if provided
    if (initialBaseline) {
      // Check if it's a valid ISO 8601 timestamp
      const timestamp = new Date(initialBaseline);
      if (isNaN(timestamp.getTime()) || initialBaseline !== timestamp.toISOString()) {
        throw new ParameterValidationError(`Invalid timestamp format for initialBaseline: ${initialBaseline}. Expected ISO 8601 format (e.g., 2025-01-01T00:00:00.000Z)`);
      }
    }

    // Ensure we have entity params (not registry params)
    const entityParams = parsedUri.params as EntityUriParams;
    if (!entityParams.id) {
      throw new ParameterValidationError('Entity ID is required for subscriptions');
    }

    // Determine subscription type from URI
    const subscriptionType = parsedUri.type === UriTemplateType.PATCH_SUBSCRIPTION ? 'patch' : 'regular';

    // Store subscription record
    this.#storage.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (subscriberId, entityId, subscriptionType, originalUri, subscribedAt) 
       VALUES (?, ?, ?, ?, ?)`,
      subscriberId,
      entityParams.id,
      subscriptionType,
      uri,
      new Date().toISOString()
    );

    // Get current entity value using ReadEntity logic - this returns the same format as resources/read
    // If the entity doesn't exist, this will throw an appropriate error
    let response: ReadResourceResult;

    try {
      // For all subscriptions (regular and patch), read the current entity state
      // Remove only the trailing /patch suffix for patch subscriptions
      const readUri = subscriptionType === 'patch' ? uri.replace(/\/patch$/, '') : uri;
      response = this.#readEntity.handleReadResource(readUri);
    } catch (err) {
      // Re-throw the error - don't allow subscribing to non-existent entities
      // This helps catch typos and ensures subscribers are only created for valid entities
      throw err;
    }

    // For patch subscriptions with initialBaseline, send immediate notification with patch from baseline to current
    if (subscriptionType === 'patch' && initialBaseline) {
      // Find the baseline snapshot
      const baselineSnapshot = this.#findSnapshotByValidFrom(entityParams.id, initialBaseline);
      if (!baselineSnapshot) {
        throw new ParameterValidationError(`No snapshot found with validFrom timestamp: ${initialBaseline}`);
      }

      // Calculate patch from baseline to current state
      const currentContent = response.contents[0];
      if (currentContent.mimeType !== 'application/json') {
        throw new Error('Expected JSON content for entity data');
      }
      const currentEntityData = JSON.parse((currentContent as any).text);
      const patch = this.#calculatePatch(JSON.parse(baselineSnapshot.value), currentEntityData.value);

      // Send immediate patch notification
      this.#sendInitialPatchNotification(subscriberId, uri, {
        entityId: currentEntityData.entityId,
        validFrom: currentEntityData.validFrom,
        validTo: currentEntityData.validTo,
        changedBy: currentEntityData.changedBy,
        deleted: currentEntityData.deleted,
        parentId: currentEntityData.parentId,
        entityTypeName: currentEntityData.entityTypeName,
        entityTypeVersion: currentEntityData.entityTypeVersion,
        patch,
        baseline: initialBaseline
      });
    }

    // Return JSON-RPC formatted response if request ID is provided
    if (requestId !== undefined) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: response
      };
    }

    return response;
  }

  /**
   * Unsubscribe a connection from resource updates for a specific entity
   * @param subscriberId - Unique subscriber identifier (per connection/tab)
   * @param uri - MCP resource URI
   * @param requestId - Optional request ID for MCP response
   * @returns Promise that resolves with unsubscription confirmation
   */
  unsubscribe(subscriberId: string, uri: string, requestId?: string | number): { unsubscribed: true; uri: string } | JSONRPCUnsubscriptionResponse {
    // Parse and validate URI
    let parsedUri;
    try {
      parsedUri = this.#uriRouter.parseEntityUri(uri);
    } catch (error) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    // Ensure we have entity params (not registry params)
    const entityParams = parsedUri.params as EntityUriParams;
    if (!entityParams.id) {
      throw new ParameterValidationError('Entity ID is required for unsubscription');
    }

    // Determine subscription type from URI
    const subscriptionType = parsedUri.type === UriTemplateType.PATCH_SUBSCRIPTION ? 'patch' : 'regular';

    // Remove subscription record using the compound key
    this.#storage.sql.exec(
      `DELETE FROM subscriptions WHERE subscriberId = ? AND entityId = ? AND subscriptionType = ?`,
      subscriberId,
      entityParams.id,
      subscriptionType
    );

    const response: { unsubscribed: true; uri: string } = {
      unsubscribed: true,
      uri
    };

    // Return JSON-RPC formatted response if request ID is provided
    if (requestId !== undefined) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: response
      };
    }

    return response;
  }

  /**
   * Get all subscriber IDs subscribed to a specific entity
   * @param entityId - Entity identifier
   * @returns Array of subscriber IDs
   */
  getSubscribersForEntity(entityId: string): string[] {
    const result = this.#storage.sql.exec(
      `SELECT subscriberId FROM subscriptions WHERE entityId = ?`,
      entityId
    );
    
    const subscribers: string[] = [];
    for (const row of result) {
      subscribers.push(row.subscriberId as string);
    }
    return subscribers;
  }

  /**
   * Remove all subscriptions for a specific subscriber (e.g., when connection closes)
   * @param subscriberId - Unique subscriber identifier
   */
  removeAllSubscriptionsForSubscriber(subscriberId: string): void {
    this.#storage.sql.exec(
      `DELETE FROM subscriptions WHERE subscriberId = ?`,
      subscriberId
    );
  }

  /**
   * Get all subscriptions for a specific subscriber
   * @param subscriberId - Unique subscriber identifier
   * @returns Array of entity IDs the subscriber is subscribed to
   */
  getSubscriptionsForSubscriber(subscriberId: string): string[] {
    const result = this.#storage.sql.exec(
      `SELECT entityId FROM subscriptions WHERE subscriberId = ?`,
      subscriberId
    );
    
    const entityIds: string[] = [];
    for (const row of result) {
      entityIds.push(row.entityId as string);
    }
    return entityIds;
  }

  /**
   * Find a snapshot by its validFrom timestamp
   */
  #findSnapshotByValidFrom(entityId: string, validFrom: string): any | null {
    try {
      const results = this.#storage.sql.exec(`
        SELECT entityId, validFrom, validTo, changedBy, value, deleted, parentId, entityTypeName, entityTypeVersion
        FROM snapshots 
        WHERE entityId = ? AND validFrom = ?
        LIMIT 1
      `, entityId, validFrom);

      const rows = results.toArray();
      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        entityId: row.entityId as string,
        validFrom: row.validFrom as string,
        validTo: row.validTo as string,
        changedBy: JSON.parse(row.changedBy as string),
        value: row.value as string, // Keep as string for now, parse when needed
        deleted: row.deleted === 1,
        parentId: row.parentId as string,
        entityTypeName: row.entityTypeName as string,
        entityTypeVersion: row.entityTypeVersion as string
      };
    } catch (error) {
      console.warn('Failed to find snapshot by validFrom', {
        entityId,
        validFrom,
        error: error instanceof Error ? error.message : error
      });
      return null;
    }
  }

  /**
   * Calculate patch between two entity value objects
   * Returns only the fields that changed between fromValue and toValue
   */
  #calculatePatch(fromValue: any, toValue: any): any {
    if (!fromValue || !toValue) {
      return toValue || {};
    }

    const patch: any = {};
    
    // Compare all keys in toValue
    for (const [key, value] of Object.entries(toValue)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively compare nested objects
        const nestedPatch = this.#calculatePatch(fromValue[key], value);
        if (Object.keys(nestedPatch).length > 0) {
          patch[key] = nestedPatch;
        }
      } else {
        // Compare primitive values and arrays
        if (JSON.stringify(fromValue[key]) !== JSON.stringify(value)) {
          patch[key] = value;
        }
      }
    }

    return patch;
  }

  /**
   * Send initial patch notification for new patch subscriptions with baseline
   */
  #sendInitialPatchNotification(subscriberId: string, uri: string, patchData: any): void {
    // This would ideally use the notification service, but to avoid circular dependencies,
    // we'll implement a simple version here for now
    console.log('Initial patch notification would be sent:', {
      subscriberId,
      uri,
      patchData
    });
    
    // TODO: Integrate with notification service to actually send the notification
    // For now, this is a placeholder to get the structure right
  }
}
