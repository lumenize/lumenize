/**
 * Comprehensive patch-based subscription test covering patch functionality
 */

import { describe, test, expect } from 'vitest';
import { runTestWithLumenize, MessageBuilders } from './test-utils';
import { EntityUriRouter, UriTemplateType } from '../src/entity-uri-router';

describe('Entity Patch Subscription', () => {
  
  // === ERROR SCENARIOS ===
  describe('Patch Subscription Error Scenarios', () => {
    test('should require initialBaseline for patch subscriptions', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Try to subscribe to a patch URI without initialBaseline
        const subscribeMessage = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/subscribe",
          params: {
            uri: 'https://lumenize/universe/default/galaxy/default/star/default/entity/test-123/patch'
            // Note: no initialBaseline parameter
          }
        });

        await instance.onMessage(mock.connection, subscribeMessage);
        const response = mock.getLastMessage();
        const result = JSON.parse(response);
        
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe(-32602); // Invalid params error code (the correct code for parameter validation)
        expect(result.error?.message).toContain('initialBaseline parameter is required for patch subscriptions');
      });
    });

    test('should error on patch subscription without existing entity', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        const uriRouter = new EntityUriRouter();
        
        // Try to subscribe to patch for non-existent entity
        const subscribeMessage = {
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/subscribe',
          params: {
            uri: uriRouter.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, {
              domain: 'lumenize',
              universe: 'default',
              galaxy: 'default',
              star: 'default',
              id: 'non-existent-entity'
            }),
            initialBaseline: '2025-07-20T23:38:22.250Z'
          }
        };

        await instance.onMessage(mock.connection, JSON.stringify(subscribeMessage));
        const response = mock.getLastMessage();
        const result = JSON.parse(response);
        
        // Should get an error for non-existent entity
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe(-32602);
        expect(result.error.message).toMatch(/No entity found|not found|does not exist/i);
      });
    });

    test('should error on invalid baseline timestamp format', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        const uriRouter = new EntityUriRouter();
        
        // Try to subscribe with invalid timestamp format
        const subscribeMessage = {
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/subscribe',
          params: {
            uri: uriRouter.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, {
              domain: 'lumenize',
              universe: 'default',
              galaxy: 'default',
              star: 'default',
              id: 'test-entity'
            }),
            initialBaseline: 'invalid-timestamp'
          }
        };

        await instance.onMessage(mock.connection, JSON.stringify(subscribeMessage));
        const response = mock.getLastMessage();
        const result = JSON.parse(response);
        
        // Should get an error for invalid timestamp
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe(-32602); // Invalid params error code for parameter validation
        expect(result.error?.message).toContain('Invalid timestamp format for initialBaseline');
      });
    });
  });

  // === COMPREHENSIVE LIFECYCLE TEST ===
  describe('Comprehensive Patch Subscription Lifecycle', () => {
  test('complete patch subscription lifecycle with initialBaseline and consecutive patches', async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // URI router for constructing test URIs
      const uriRouter = new EntityUriRouter();
      
      // Clear any previous state
      mock.clearNotifications();
      mock.clearMessages();

      const startTime = performance.now();

      // === PHASE 1: Entity Type Creation ===
      const createEntityTypeMessage = MessageBuilders.toolCall(1, 'add-entity-type', {
        name: 'patch-test-entity',
        version: 1,
        jsonSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string' },
            metadata: { 
              type: 'object',
              properties: {
                version: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
                lastModified: { type: 'string' }
              }
            },
            counters: {
              type: 'object',
              properties: {
                views: { type: 'number' },
                updates: { type: 'number' }
              }
            }
          },
          required: ['name', 'status']
        }
      });

      await instance.onMessage(mock.connection, createEntityTypeMessage);
      const result1 = mock.getMessageById(1);
      expect(result1.error).toBeUndefined();
      
      // === PHASE 2: Initial Entity Creation ===
      const entityId = 'patch-test-123';
      const initialData = {
        name: 'Patch Test Entity',
        status: 'created',
        metadata: { version: 1, tags: ['test', 'patch'], lastModified: new Date().toISOString() },
        counters: { views: 0, updates: 0 }
      };

      const createEntityMessage = MessageBuilders.toolCall(2, 'upsert-entity', {
        entityId,
        entityTypeName: 'patch-test-entity',
        entityTypeVersion: 1,
        changedBy: [{ userId: 'test-user' }],
        parentId: 'test-parent',
        value: initialData
      });

      await instance.onMessage(mock.connection, createEntityMessage);
      const result2 = mock.getMessageById(2);
      if (result2.error) {
        throw new Error(`Entity creation failed: ${result2.error.message}`);
      }

      expect(result2.result.structuredContent.success).toBe(true);
      expect(result2.result.structuredContent.entityId).toBe(entityId);
      
      const originalCreationTimestamp = result2.result.structuredContent.validFrom;

      // STOPPED REVIEWING HERE
      
      // === PHASE 3: First Update to Create History ===
      const firstUpdateData = {
        ...initialData,
        status: 'updated',
        metadata: { 
          ...initialData.metadata, 
          version: 2, 
          lastModified: new Date().toISOString() 
        },
        counters: { views: 1, updates: 1 }
      };

      const firstUpdateMessage = MessageBuilders.toolCall(3, 'upsert-entity', {
        entityId,
        entityTypeName: 'patch-test-entity',
        entityTypeVersion: 1,
        changedBy: [{ userId: 'test-user' }],
        parentId: 'test-parent',
        value: firstUpdateData
      });

      await instance.onMessage(mock.connection, firstUpdateMessage);
      const result3 = mock.getMessageById(3);
      expect(result3.error).toBeUndefined();
      
      const firstUpdateTimestamp = result3.result.structuredContent.validFrom;

      // === PHASE 4: Second Update to Create More History ===
      const secondUpdateData = {
        ...firstUpdateData,
        status: 'modified',
        metadata: { 
          ...firstUpdateData.metadata, 
          version: 3, 
          tags: ['test', 'patch', 'modified'],
          lastModified: new Date().toISOString() 
        },
        counters: { views: 5, updates: 2 }
      };

      const secondUpdateMessage = MessageBuilders.toolCall(4, 'upsert-entity', {
        entityId,
        entityTypeName: 'patch-test-entity',
        entityTypeVersion: 1,
        changedBy: [{ userId: 'test-user' }],
        parentId: 'test-parent',
        value: secondUpdateData
      });

      await instance.onMessage(mock.connection, secondUpdateMessage);
      const result4 = mock.getMessageById(4);
      expect(result4.error).toBeUndefined();
      
      const secondUpdateTimestamp = result4.result.structuredContent.validFrom;

      // === PHASE 5: Patch Subscription with initialBaseline ===
      // Subscribe to patch updates starting from the first update timestamp
      const patchUri = uriRouter.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, {
        domain: 'lumenize',
        universe: 'default',
        galaxy: 'default',
        star: 'default',
        id: entityId
      });
      
      const patchSubscribeMessage = {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/subscribe',
        params: {
          uri: patchUri,
          initialBaseline: firstUpdateTimestamp
        }
      };

      mock.clearNotifications(); // Clear before subscription
      await instance.onMessage(mock.connection, JSON.stringify(patchSubscribeMessage));
      const subscribeResponse = mock.getLastMessage();
      expect(subscribeResponse).toBeDefined();
      
      const subscribeResult = JSON.parse(subscribeResponse);
      expect(subscribeResult.id).toBe(5);
      expect(subscribeResult.error).toBeUndefined();
      
      // Wait for any immediate notifications
      await new Promise(resolve => setTimeout(resolve, 100));
      const immediateNotifications = mock.getNotifications();
      
      // Should receive a patch notification from firstUpdate to current (secondUpdate)
      if (immediateNotifications.length > 0) {
        const patchNotification = immediateNotifications[0];
        expect(patchNotification.method).toBe('notifications/resources/updated');
        expect(patchNotification.params.data.baseline).toBe(firstUpdateTimestamp);
        expect(patchNotification.params.data.patch).toBeDefined();
        
        // The patch should contain the differences between firstUpdate and secondUpdate
        expect(patchNotification.params.data.patch.status).toBe('modified');
        expect(patchNotification.params.data.patch.metadata.version).toBe(3);
        expect(patchNotification.params.data.patch.metadata.tags).toEqual(['test', 'patch', 'modified']);
        expect(patchNotification.params.data.patch.counters.views).toBe(5);
        expect(patchNotification.params.data.patch.counters.updates).toBe(2);
      }

      // === PHASE 6: Make Another Update to Test Consecutive Patches ===
      mock.clearNotifications(); // Clear before update
      
      const thirdUpdateData = {
        ...secondUpdateData,
        status: 'finalized',
        metadata: { 
          ...secondUpdateData.metadata, 
          version: 4, 
          tags: ['test', 'patch', 'finalized'],
          lastModified: new Date().toISOString() 
        },
        counters: { views: 10, updates: 3 }
      };

      const thirdUpdateMessage = MessageBuilders.toolCall(6, 'upsert-entity', {
        entityId,
        entityTypeName: 'patch-test-entity',
        entityTypeVersion: 1,
        changedBy: [{ userId: 'test-user' }],
        parentId: 'test-parent',
        value: thirdUpdateData
      });

      await instance.onMessage(mock.connection, thirdUpdateMessage);
      const result6 = mock.getMessageById(6);
      expect(result6.error).toBeUndefined();
      
      const thirdUpdateTimestamp = result6.result.structuredContent.validFrom;

      // === PHASE 7: Validate Consecutive Patch Notification ===
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for notification
      const patchNotifications = mock.getNotifications();
      expect(patchNotifications).toHaveLength(1); // Should receive one patch notification
      
      const consecutivePatchNotification = patchNotifications[0];
      expect(consecutivePatchNotification.method).toBe('notifications/resources/updated');
      expect(consecutivePatchNotification.params.uri).toContain('/patch');
      expect(consecutivePatchNotification.params.data.baseline).toBe(secondUpdateTimestamp);
      expect(consecutivePatchNotification.params.data.patch).toBeDefined();
      
      // The patch should only contain differences between secondUpdate and thirdUpdate
      expect(consecutivePatchNotification.params.data.patch.status).toBe('finalized');
      expect(consecutivePatchNotification.params.data.patch.metadata.version).toBe(4);
      expect(consecutivePatchNotification.params.data.patch.metadata.tags).toEqual(['test', 'patch', 'finalized']);
      expect(consecutivePatchNotification.params.data.patch.counters.views).toBe(10);
      expect(consecutivePatchNotification.params.data.patch.counters.updates).toBe(3);
      
      // Should NOT include unchanged fields
      expect(consecutivePatchNotification.params.data.patch.name).toBeUndefined();
      
      // Should NOT include value field for patch subscriptions
      expect(consecutivePatchNotification.params.data.value).toBeUndefined();
      
      // === PHASE 8: Test Patch Read Operation ===
      // Test reading patch from original creation to current
      const patchReadMessage = {
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/read',
        params: {
          uri: uriRouter.buildEntityUri(UriTemplateType.PATCH_READ, {
            domain: 'lumenize',
            universe: 'default',
            galaxy: 'default',
            star: 'default',
            id: entityId,
            baseline: originalCreationTimestamp
          })
        }
      };

      await instance.onMessage(mock.connection, JSON.stringify(patchReadMessage));
      const patchReadResponse = mock.getLastMessage();
      expect(patchReadResponse).toBeDefined();
      
      const patchReadResult = JSON.parse(patchReadResponse);
      expect(patchReadResult.id).toBe(7);
      expect(patchReadResult.error).toBeUndefined();
      
      const patchData = JSON.parse(patchReadResult.result.contents[0].text);
      expect(patchData.baseline).toBe(originalCreationTimestamp);
      expect(patchData.patch).toBeDefined();
      
      // Should show complete changes from original to current
      expect(patchData.patch.status).toBe('finalized');
      expect(patchData.patch.metadata.version).toBe(4);
      expect(patchData.patch.counters.views).toBe(10);
      expect(patchData.patch.counters.updates).toBe(3);
      
      // === PHASE 9: Test Delete Operation with Patch Subscription ===
      mock.clearNotifications();
      
      const deleteMessage = MessageBuilders.toolCall(8, 'delete-entity', {
        entityId,
        changedBy: [{ userId: 'test-user' }]
      });

      await instance.onMessage(mock.connection, deleteMessage);
      const deleteResult = mock.getMessageById(8);
      expect(deleteResult.error).toBeUndefined();
      
      // Wait for delete notification
      await new Promise(resolve => setTimeout(resolve, 100));
      const deleteNotifications = mock.getNotifications();
      expect(deleteNotifications).toHaveLength(1);
      
      const deletePatchNotification = deleteNotifications[0];
      expect(deletePatchNotification.method).toBe('notifications/resources/updated');
      expect(deletePatchNotification.params.uri).toContain('/patch');
      expect(deletePatchNotification.params.data.deleted).toBe(true);
      expect(deletePatchNotification.params.data.baseline).toBe(thirdUpdateTimestamp);
      
      // === PHASE 10: Test Undelete Operation ===
      mock.clearNotifications();
      
      const undeleteMessage = MessageBuilders.toolCall(9, 'undelete-entity', {
        entityId,
        changedBy: [{ userId: 'test-user' }]
      });

      await instance.onMessage(mock.connection, undeleteMessage);
      const undeleteResult = mock.getMessageById(9);
      expect(undeleteResult.error).toBeUndefined();
      
      // Wait for undelete notification
      await new Promise(resolve => setTimeout(resolve, 100));
      const undeleteNotifications = mock.getNotifications();
      expect(undeleteNotifications).toHaveLength(1);
      
      const undeletePatchNotification = undeleteNotifications[0];
      expect(undeletePatchNotification.method).toBe('notifications/resources/updated');
      expect(undeletePatchNotification.params.uri).toContain('/patch');
      expect(undeletePatchNotification.params.data.deleted).toBe(false);
      expect(undeletePatchNotification.params.data.baseline).toBeDefined();
      
      // === PHASE 11: Unsubscribe ===
      const unsubscribeMessage = {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/unsubscribe',
        params: {
          uri: uriRouter.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, {
            domain: 'lumenize',
            universe: 'default',
            galaxy: 'default',
            star: 'default',
            id: entityId
          })
        }
      };

      await instance.onMessage(mock.connection, JSON.stringify(unsubscribeMessage));
      const unsubscribeResponse = mock.getLastMessage();
      const unsubscribeResult = JSON.parse(unsubscribeResponse);
      
      expect(unsubscribeResult.id).toBe(10);
      expect(unsubscribeResult.error).toBeUndefined();
      expect(unsubscribeResult.result.result.unsubscribed).toBe(true);
      
      // === PHASE 12: Test Invalid initialBaseline ===
      const invalidPatchSubscribeMessage = {
        jsonrpc: '2.0',
        id: 11,
        method: 'resources/subscribe',
        params: {
          uri: uriRouter.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, {
            domain: 'lumenize',
            universe: 'default',
            galaxy: 'default',
            star: 'default',
            id: entityId
          }),
          initialBaseline: '2024-01-01T00:00:00.000Z' // Invalid timestamp
        }
      };

      await instance.onMessage(mock.connection, JSON.stringify(invalidPatchSubscribeMessage));
      const invalidSubscribeResponse = mock.getLastMessage();
      const invalidSubscribeResult = JSON.parse(invalidSubscribeResponse);
      expect(invalidSubscribeResult.id).toBe(11);
      expect(invalidSubscribeResult.error).toBeDefined();
      expect(invalidSubscribeResult.error.message).toContain('No snapshot found');
      
      const totalTime = performance.now() - startTime;
    });
  }, 30000); // 30 second timeout for comprehensive test
  });
});
