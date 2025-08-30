/**
 * Unit tests for EntitySubscriptions class
 * Tests the subscription management methods that aren't covered by integration tests
 */

import { describe, test, expect } from 'vitest';
import { EntitySubscriptions } from '../src/entity-subscriptions';

describe('EntitySubscriptions Unit Tests', () => {
  test('confirms notifySubscribers method was removed (dead code cleanup)', () => {
    // Create a dummy instance to test the interface
    const dummyStorage: any = { 
      sql: { 
        exec: () => [] // Return array directly
      } 
    };
    const dummyReadEntity: any = {};
    const dummyUriRouter: any = {};
    
    const subscriptions = new EntitySubscriptions(dummyStorage, dummyReadEntity, dummyUriRouter);
    
    // The notifySubscribers method should no longer exist
    // Use bracket notation to avoid TypeScript compile errors
    expect((subscriptions as any).notifySubscribers).toBeUndefined();
    expect(typeof (subscriptions as any).notifySubscribers).toBe('undefined');
    expect('notifySubscribers' in subscriptions).toBe(false);
    
    // These methods should still exist (they're still used)
    expect(typeof subscriptions.subscribe).toBe('function');
    expect(typeof subscriptions.unsubscribe).toBe('function');
    expect(typeof subscriptions.getSubscribersForEntity).toBe('function');
    expect(typeof subscriptions.removeAllSubscriptionsForSubscriber).toBe('function');
    expect(typeof subscriptions.getSubscriptionsForSubscriber).toBe('function');
  });

  test('subscription management interface is preserved', () => {
    // This test ensures we kept the subscription management methods that might be useful
    const dummyStorage: any = { 
      sql: { 
        exec: () => [] // Return array directly since that's what the methods expect to iterate over
      } 
    };
    const dummyReadEntity: any = {};
    const dummyUriRouter: any = {};
    
    const subscriptions = new EntitySubscriptions(dummyStorage, dummyReadEntity, dummyUriRouter);
    
    // Test that we can call the methods without errors (they should handle dummy data gracefully)
    expect(() => subscriptions.getSubscribersForEntity('dummy-entity')).not.toThrow();
    expect(() => subscriptions.getSubscriptionsForSubscriber('dummy-subscriber')).not.toThrow();
    expect(() => subscriptions.removeAllSubscriptionsForSubscriber('dummy-subscriber')).not.toThrow();
    
    // These should return empty arrays with dummy storage
    expect(subscriptions.getSubscribersForEntity('dummy-entity')).toEqual([]);
    expect(subscriptions.getSubscriptionsForSubscriber('dummy-subscriber')).toEqual([]);
  });
});
