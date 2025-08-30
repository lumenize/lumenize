import { EntityUriRouter, UriTemplateType } from './entity-uri-router';

/**
 * Notification service interface for sending notifications to clients
 * This abstraction allows switching between WebSocket, SSE, or other transport mechanisms
 */
export interface NotificationService {
  /**
   * Send a notification to all subscribers for an entity
   * @param entityId - The entity identifier
   * @param entityTypeName - The entity type name
   * @param entityTypeVersion - The entity type version
   * @param notification - The notification payload
   * @param previousValue - Optional previous entity value for patch calculations (avoids database query)
   * @param baseline - Optional baseline timestamp for patch baseline confirmation
   */
  sendEntityNotification(
    entityId: string, 
    entityTypeName: string, 
    entityTypeVersion: string,
    notification: any,
    previousValue?: any,
    baseline?: string
  ): void;

  /**
   * Send an entity update notification
   * @param entityId - The entity identifier
   * @param entityData - The updated entity data to include in notification (contains entityTypeName and entityTypeVersion)
   * @param previousValue - Optional previous entity value for patch calculations (avoids database query)
   * @param baseline - Optional baseline timestamp for patch baseline confirmation
   */
  sendEntityUpdateNotification(
    entityId: string,
    entityData: any,
    previousValue?: any,
    baseline?: string
  ): void;
}

/**
 * WebSocket-based notification service compatible with Cloudflare Durable Objects
 * 
 * This service works with Cloudflare Durable Objects by:
 * - Using ctx.getWebSockets(tag) to find active WebSockets by sessionId
 * - Not storing any state in memory (hibernation-safe)
 * - Leveraging Cloudflare's built-in WebSocket management
 */
export class WebSocketNotificationService implements NotificationService {
  private server: any; // The Durable Object server instance with ctx.getWebSockets()
  private storage: DurableObjectStorage; // For persistent subscription data
  private uriRouter: EntityUriRouter; // For consistent URI construction

  constructor(server: any, storage: DurableObjectStorage, uriRouter: EntityUriRouter) {
    this.server = server;
    this.storage = storage;
    this.uriRouter = uriRouter;
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
   * Get the previous entity snapshot for patch calculation
   */
  #getPreviousSnapshot(entityId: string, currentValidFrom: string): any | null {
    try {
      const results = this.storage.sql.exec(`
        SELECT value, validFrom, validTo, changedBy, deleted, parentId, entityTypeName, entityTypeVersion
        FROM snapshots 
        WHERE entityId = ? AND validTo = ?
        ORDER BY validFrom DESC
        LIMIT 1
      `, entityId, currentValidFrom);

      const rows = results.toArray();
      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        entityId,
        validFrom: row.validFrom as string,
        validTo: row.validTo as string,
        changedBy: JSON.parse(row.changedBy as string),
        value: JSON.parse(row.value as string),
        deleted: row.deleted === 1,
        parentId: row.parentId as string,
        entityTypeName: row.entityTypeName as string,
        entityTypeVersion: row.entityTypeVersion as string
      };
    } catch (error) {
      console.warn('Failed to get previous snapshot for patch calculation', {
        entityId,
        currentValidFrom,
        error: error instanceof Error ? error.message : error
      });
      return null;
    }
  }

  /**
   * Send notification to all subscribers for an entity
   * Uses Cloudflare's ctx.getWebSockets() to find active connections by sessionId tag
   */  
  sendEntityNotification(
    entityId: string,
    entityTypeName: string,
    entityTypeVersion: string,
    notification: any,
    previousValue?: any,
    baseline?: string
  ): void {
    // Get all subscription records for this entity from persistent storage
    const subscriptions = this.#getEntitySubscriptions(entityId);
    
    // For each subscriber, try to find active connection and send notification
    for (const subscription of subscriptions) {
      try {

        // Try to use Cloudflare's WebSocket API first (production environment)
        if (this.server.ctx && typeof this.server.ctx.getWebSockets === 'function') {
          // Use Cloudflare's Durable Object WebSocket API to get connections by tag
          const webSockets = this.server.ctx.getWebSockets(subscription.subscriberId);
          
          console.debug('Found WebSockets for subscriber (Cloudflare API)', { 
            subscriberId: subscription.subscriberId, 
            webSocketCount: webSockets ? webSockets.length : 0 
          });

          if (webSockets && webSockets.length > 0) {
            let finalNotification = notification;
            
            if (subscription.subscriptionType === 'patch') {
              // This is a patch subscription - send patch format instead of full entity data
              finalNotification = {
                ...notification,
                params: {
                  ...notification.params,
                  uri: subscription.originalUri // Use the patch URI directly
                }
              };
              
              // Remove the 'value' field and add 'patch' field for patch subscriptions
              if (finalNotification.params.data && finalNotification.params.data.value) {
                const currentData = finalNotification.params.data;
                
                // Use provided previousValue if available, otherwise query database
                let previousSnapshot = null;
                let baselineFrom = null;
                
                if (previousValue) {
                  // Use the provided previous value directly - no database query needed
                  previousSnapshot = { value: previousValue };
                  baselineFrom = baseline; // Use provided baseline
                } else {
                  // Fallback to database query if previousValue not provided
                  const dbSnapshot = this.#getPreviousSnapshot(entityId, currentData.validFrom);
                  if (dbSnapshot) {
                    previousSnapshot = dbSnapshot;
                    baselineFrom = dbSnapshot.validFrom;
                  }
                }
                
                if (previousSnapshot) {
                  const patch = this.#calculatePatch(previousSnapshot.value, currentData.value);
                  finalNotification.params.data = {
                    entityId: currentData.entityId,
                    validFrom: currentData.validFrom,
                    validTo: currentData.validTo,
                    changedBy: currentData.changedBy,
                    deleted: currentData.deleted,
                    parentId: currentData.parentId,
                    entityTypeName: currentData.entityTypeName,
                    entityTypeVersion: currentData.entityTypeVersion,
                    patch,
                    baseline: baselineFrom  // The snapshot the patch should be applied to
                  };
                  // Explicitly do not include 'value' field for patch subscriptions
                } else {
                  // If no previous snapshot, include full value as patch
                  finalNotification.params.data = {
                    entityId: currentData.entityId,
                    validFrom: currentData.validFrom,
                    validTo: currentData.validTo,
                    changedBy: currentData.changedBy,
                    deleted: currentData.deleted,
                    parentId: currentData.parentId,
                    entityTypeName: currentData.entityTypeName,
                    entityTypeVersion: currentData.entityTypeVersion,
                    patch: currentData.value,
                    baseline: null  // No previous snapshot to compare against
                  };
                }
              }
            }

            // Send to all WebSockets for this session
            for (const webSocket of webSockets) {
              const message = JSON.stringify({
                type: 'mcp',
                payload: finalNotification
              });
              
              webSocket.send(message);
            }
            
            console.debug('Sent entity notification via Cloudflare WebSockets', {
              subscriberId: subscription.subscriberId,
              entityId,
              entityTypeName,
              entityTypeVersion,
              webSocketCount: webSockets.length,
              isPatchSubscription: subscription.subscriptionType === 'patch'
            });
          } else {
            console.debug('No active WebSockets found for subscription', {
              subscriberId: subscription.subscriberId,
              entityId
            });
          }
        } else {
          console.warn('Cloudflare WebSocket API not available', {
            hasCtx: !!this.server.ctx,
            hasGetWebSockets: this.server.ctx && typeof this.server.ctx.getWebSockets === 'function',
            subscriberId: subscription.subscriberId
          });
        }
      } catch (error) {
        console.error('Failed to send notification to subscriber', {
          subscriberId: subscription.subscriberId,
          entityId,
          error: error instanceof Error ? error.message : error
        });
      }
    }
  }

  /**
   * Get all subscriptions for a specific entity from persistent storage
   */
  #getEntitySubscriptions(
    entityId: string, 
  ): Array<{ subscriberId: string; subscriptionType: string; originalUri: string; subscribedAt: string }> {
    // Query the subscriptions table for this entity
    // This uses the same storage as the EntitySubscriptions class
    const results = this.storage.sql.exec(`
      SELECT subscriberId, subscriptionType, originalUri, subscribedAt
      FROM subscriptions 
      WHERE entityId = ?
    `, entityId);

    const subscriptions = results.toArray().map(row => ({
      subscriberId: row.subscriberId as string,
      subscriptionType: row.subscriptionType as string,
      originalUri: row.originalUri as string,
      subscribedAt: row.subscribedAt as string
    }));
    
    return subscriptions;
  }

  /**
   * Send an entity update notification
   * Handles entity type extraction from entity data and notification payload building
   */
  sendEntityUpdateNotification(
    entityId: string,
    entityData: any,
    previousValue?: any,
    baseline?: string
  ): void {
    // Extract entity type from entity data
    const entityTypeName = entityData.entityTypeName;
    const entityTypeVersion = entityData.entityTypeVersion;

    console.debug('WebSocketNotificationService.sendEntityUpdateNotification called', {
      entityId,
      entityTypeName,
      entityTypeVersion,
      entityData
    });

    // Build URI using the centralized URI router (simplified - no entity type in URI)
    const uri = this.uriRouter.buildEntityUri(UriTemplateType.CURRENT_ENTITY, {
      domain: 'lumenize',
      universe: 'default',
      galaxy: 'default',
      star: 'default',
      id: entityId
    });

    // Build the MCP-style notification payload with actual entity data
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: {
        uri,
        title: `Entity ${entityTypeName}@${entityTypeVersion}: ${entityId}`,
        // Include the actual updated entity data so clients don't need to fetch it
        data: entityData
      }
    };

    // Send using existing notification method
    this.sendEntityNotification(entityId, entityTypeName, entityTypeVersion, notification, previousValue, baseline);
  }
}

/**
 * SSE-based notification service (stub implementation)
 * 
 * This service will support Server-Sent Events as a transport mechanism
 * for situations where WebSockets are not available or preferred.
 */
export class SSENotificationService implements NotificationService {
  private uriRouter: EntityUriRouter; // For consistent URI construction

  constructor(uriRouter: EntityUriRouter) {
    this.uriRouter = uriRouter;
  }

  /**
   * Send notification via Server-Sent Events
   * @param entityId - The entity identifier
   * @param entityTypeName - The entity type name
   * @param entityTypeVersion - The entity type version
   * @param notification - The notification payload
   * @param previousValue - Optional previous entity value for patch calculations (avoids database query)
   * @param baseline - Optional baseline timestamp for patch baseline confirmation
   */
  sendEntityNotification(
    entityId: string,
    entityTypeName: string,
    entityTypeVersion: string,
    notification: any,
    previousValue?: any,
    baseline?: string
  ): void {
    // TODO: Implement SSE notification delivery
    // This would involve:
    // 1. Finding active SSE connections for entity subscribers
    // 2. Formatting notifications for SSE protocol
    // 3. Sending notifications via HTTP response streams
    
    console.log('SSE notifications coming soon... or at least someday... maybe', {
      entityId,
      entityTypeName,
      entityTypeVersion,
      notification
    });
    
    // For now, just a placeholder that logs the notification
    // In the future, this would interface with an SSE connection manager
  }

  /**
   * Send an entity update notification
   * @param entityId - The entity identifier
   * @param entityData - The updated entity data to include in notification (contains entityTypeName and entityTypeVersion)
   * @param previousValue - Optional previous entity value for patch calculations (avoids database query)
   * @param baseline - Optional baseline timestamp for patch baseline confirmation
   */
  sendEntityUpdateNotification(
    entityId: string,
    entityData: any,
    previousValue?: any,
    baseline?: string
  ): void {
    // Extract entity type from entity data
    const entityTypeName = entityData.entityTypeName;
    const entityTypeVersion = entityData.entityTypeVersion;
    
    // TODO: Implement entity update notification delivery via SSE
    // This would involve:
    // 1. Finding active SSE connections for entity subscribers
    // 2. Formatting update notifications with entity type information and data
    // 3. Sending notifications via HTTP response streams
    
    console.log('Entity update notifications via SSE coming soon... or at least someday... maybe', {
      entityId,
      entityTypeName,
      entityTypeVersion,
      entityData
    });
    
    // For now, just a placeholder that logs the update notification
    // In the future, this would interface with an SSE connection manager
  }
}
