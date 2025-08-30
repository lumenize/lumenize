import { Entities } from './entities';
import * as jsonmergepatch from './json-merge-patch';
import { ReadResourceResult, TextResourceContents } from './schema/draft/schema';
import { getCurrentSnapshotPublic, PUBLIC_FIELDS } from './snapshot-utils';
import { 
  ParameterValidationError, 
  EntityTypeNotFoundError,
  EntityNotFoundError, 
  SnapshotNotFoundError, 
  EntityDeletedError, 
  InvalidUriError 
} from './errors';
import { 
  EntityUriRouter, 
  UriTemplateType, 
  type PatchUriParams, 
  type HistoricalUriParams, 
  type EntityUriParams 
} from './entity-uri-router';

export interface EntitySnapshot {
  entityId: string;
  validFrom: string;
  validTo: string;
  changedBy: string;
  value: string;
  deleted: boolean;
  parentId: string | null;
  entityTypeName: string;
  entityTypeVersion: string;
}

export interface ReadEntityResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
  }>;
}

export class ReadEntity {
  readonly #storage: DurableObjectStorage;
  readonly #entities: Entities;
  readonly #uriRouter: EntityUriRouter;

  constructor(
    storage: DurableObjectStorage,
    entities: Entities,
    uriRouter: EntityUriRouter
  ) {
    this.#storage = storage;
    this.#entities = entities;
    this.#uriRouter = uriRouter;
  }

  /**
   * Parse URI using the new entity URI router
   * Returns parsed URI information and extracted entity ID
   */
  #parseEntityUri(uri: string): {
    parsedUri: ReturnType<EntityUriRouter['parseEntityUri']>;
    entityId?: string;
  } {
    const parsedUri = this.#uriRouter.parseEntityUri(uri);
    
    // Handle entity registry URIs separately (no entity type or ID)
    if (parsedUri.type === UriTemplateType.ENTITY_REGISTRY) {
      return {
        parsedUri
      };
    }
    
    // Extract entity ID from URI parameters (entity type comes from database)
    const entityParams = parsedUri.params as EntityUriParams;
    
    return {
      parsedUri,
      entityId: entityParams.id
    };
  }

  /**
   * Get a specific snapshot by entityId and validFrom
   */
  #getSnapshotByValidFrom(entityId: string, validFrom: string): EntitySnapshot | null {
    const results = this.#storage.sql.exec(`
      SELECT ${PUBLIC_FIELDS.join(', ')}
      FROM snapshots 
      WHERE entityId = ? AND validFrom = ?
    `, entityId, validFrom).toArray();
    
    if (results.length === 0) {
      return null;
    }
    
    const snapshot = results[0] as any;
    return {
      ...snapshot,
      deleted: Boolean(snapshot.deleted)
    };
  }

  /**
   * Get a snapshot that is valid at a specific moment in time
   */
  #getSnapshotValidAt(entityId: string, at: string): EntitySnapshot | null {
    const results = this.#storage.sql.exec(`
      SELECT ${PUBLIC_FIELDS.join(', ')}
      FROM snapshots 
      WHERE entityId = ? AND validFrom <= ? AND validTo >= ?
    `, entityId, at, at).toArray();
    
    if (results.length === 0) {
      return null;
    }
    
    const snapshot = results[0] as any;
    return {
      ...snapshot,
      deleted: Boolean(snapshot.deleted)
    };
  }

  /**
   * Read entity data by URI (supports both MCP and HTTP requests)
   */
  readEntity(uri: string): ReadEntityResult {
    const { parsedUri, entityId } = this.#parseEntityUri(uri);

    // Handle entity registry URIs
    if (parsedUri.type === UriTemplateType.ENTITY_REGISTRY) {
      // Return complete entity type registry as JSON
      const entityTypes = this.#entities.listEntityTypeDefinitions();
      
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(entityTypes, null, 2)
        }]
      };
    }

    // For entity URIs, we need entity ID to be defined
    if (!entityId) {
      throw new InvalidUriError('Entity URIs must have an entity ID');
    }

    let targetSnapshot: EntitySnapshot | null;

    // Handle different URI template types - get the appropriate snapshot first
    switch (parsedUri.type) {
      case UriTemplateType.HISTORICAL: {
        // Template 4: Historical Point-in-Time Resource
        const historicalParams = parsedUri.params as HistoricalUriParams;
        targetSnapshot = this.#getSnapshotValidAt(entityId, historicalParams.timestamp);
        if (!targetSnapshot) {
          throw new SnapshotNotFoundError(`No snapshot found for entity ${entityId} at time ${historicalParams.timestamp}`);
        }
        break;
      }
      
      case UriTemplateType.PATCH_READ:
      case UriTemplateType.CURRENT_ENTITY:
      case UriTemplateType.PATCH_SUBSCRIPTION:
      default: {
        // Template 1, 2, 3: Current Entity Resource or operations based on current state
        targetSnapshot = getCurrentSnapshotPublic(this.#storage, entityId);
        if (!targetSnapshot) {
          throw new EntityNotFoundError(`No entity found with ID: ${entityId}`);
        }
        break;
      }
    }

    if (targetSnapshot.deleted) {
      throw new EntityDeletedError(`Entity has been deleted: ${entityId}`);
    }

    // Extract entity type information from the snapshot (no separate database query needed!)
    const entityTypeName = targetSnapshot.entityTypeName;
    const entityTypeVersion = targetSnapshot.entityTypeVersion;

    if (!entityTypeName || !entityTypeVersion) {
      throw new EntityNotFoundError(`Entity ${entityId} missing type information`);
    }

    let mimeType = 'application/json';

    // Create base response object with metadata
    const responseData: any = {
      entityId: targetSnapshot.entityId,
      validFrom: targetSnapshot.validFrom,
      validTo: targetSnapshot.validTo,
      changedBy: JSON.parse(targetSnapshot.changedBy),
      deleted: targetSnapshot.deleted,
      parentId: targetSnapshot.parentId,
      entityTypeName,
      entityTypeVersion
    };

    // Handle different response formats based on URI template type
    if (parsedUri.type === UriTemplateType.PATCH_READ) {
      // Template 3: Return a merge patch from the specified baseline timestamp
      const patchParams = parsedUri.params as PatchUriParams;
      const fromSnapshot = this.#getSnapshotByValidFrom(entityId, patchParams.baseline);
      if (!fromSnapshot) {
        throw new SnapshotNotFoundError(`Snapshot not found for validFrom: ${patchParams.baseline}`);
      }

      const fromValue = JSON.parse(fromSnapshot.value);
      const targetValue = JSON.parse(targetSnapshot.value);
      
      // Generate merge patch from old to new
      const mergePatch = jsonmergepatch.generate(fromValue, targetValue);
      responseData.patch = mergePatch;
      responseData.baseline = patchParams.baseline;
    } else if (parsedUri.type === UriTemplateType.HISTORICAL) {
      // Template 4: Return full value from historical snapshot
      const historicalParams = parsedUri.params as HistoricalUriParams;
      responseData.value = JSON.parse(targetSnapshot.value);
      responseData.at = historicalParams.timestamp;
    } else {
      // Template 1 & 2: Return full value from target snapshot
      responseData.value = JSON.parse(targetSnapshot.value);
    }

    // Create response with metadata
    const result: ReadEntityResult = {
      contents: [{
        uri,
        mimeType,
        text: JSON.stringify(responseData, null, 2)
      }]
    };

    return result;
  }

  /**
   * Handle read resource request (supports both MCP and HTTP protocols)
   * @param uri - The resource URI to read
   * @returns ReadResourceResult with resource contents
   */
  handleReadResource(uri: string): ReadResourceResult {
    // Validate required uri parameter
    if (!uri || typeof uri !== 'string') {
      throw new ParameterValidationError('uri parameter is required and must be a string');
    }

    const result = this.readEntity(uri);
    
    // Convert ReadEntityResult to ReadResourceResult 
    // Since we only deal with text resources, convert all contents to TextResourceContents
    const contents: TextResourceContents[] = result.contents.map(content => ({
      uri: content.uri,
      mimeType: content.mimeType || 'application/json',
      text: content.text || ''
    }));

    return { contents };
  }

  /**
   * Handle HTTP request using the handler pattern
   * Returns Response if this handler should process the request, undefined otherwise
   */
  handleRequest(request: Request): Response | undefined {
    const url = new URL(request.url);
    
    // Only handle GET requests to entity URIs or entity-types URIs
    if (request.method !== 'GET' || (!url.pathname.includes('/entity/') && !url.pathname.includes('/entity-types'))) {
      return undefined;
    }
    
    return this.handleHTTPRead(request);
  }

  /**
   * Handle HTTP GET request - same functionality as MCP read
   */
  handleHTTPRead(request: Request): Response {
    try {
      const result = this.readEntity(request.url);
      
      const content = result.contents[0];
      // No need to confirm that it's not empty because this.readEntity throws if that happens
      
      return new Response(content.text, {
        status: 200,
        headers: {
          'Content-Type': content.mimeType || 'application/json',
          'Cache-Control': 'no-cache' // Entity data can change frequently
        }
      });
    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'ReadEntity.handleHTTPRead',
        error: error instanceof Error ? error.message : 'Unknown error',
        url: request.url
      });

      // Handle different error types with appropriate HTTP status codes
      if (error instanceof EntityNotFoundError || 
          error instanceof SnapshotNotFoundError || 
          error instanceof EntityDeletedError ||
          error instanceof EntityTypeNotFoundError) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      
      if (error instanceof InvalidUriError || 
          error instanceof ParameterValidationError) {
        return Response.json({ error: error.message }, { status: 400 });
      }

      // Unknown/unexpected errors
      return Response.json(
        { error: 'Internal server error' }, 
        { status: 500 }
      );
    }
  }
}
