import { describe, it, expect } from 'vitest';
import { runTestWithLumenize } from './test-utils';

describe('Connection Tags Integration', () => {
  it('should properly exercise getConnectionTags in test infrastructure', async () => {
    await runTestWithLumenize(async (instance, mock) => {
      // Get the connection tags that the server actually assigned
      const tags = mock.getConnectionTags(instance);
      
      // Verify that getConnectionTags was called and returned expected tags
      expect(tags).toBeDefined();
      expect(Array.isArray(tags)).toBe(true);
      expect(tags.length).toBeGreaterThan(0);
      
      // Extract subscriberId from the mock connection URL to verify it matches the tag
      const url = new URL(mock.ctx.request.url);
      const subscriberId = url.searchParams.get('subscriberId');
      expect(subscriberId).toBeDefined();
      
      // The primary tag should be the subscriberId
      expect(tags).toContain(subscriberId!);
    });
  });

  it('should handle authentication failure in getConnectionTags correctly', async () => {
    await runTestWithLumenize(async (instance, mock) => {
      // Remove the sessionId cookie to simulate authentication failure
      mock.removeHeader('cookie');
      
      // Get connection tags with missing authentication
      const tags = mock.getConnectionTags(instance);
      
      // Should return unauthenticated tag when sessionId is missing
      expect(tags).toEqual(['unauthenticated']);
    });
  });

  it('should handle missing subscriberId in getConnectionTags correctly', async () => {
    await runTestWithLumenize(async (instance, mock) => {
      // Create a mock context without subscriberId in URL
      const mockContextWithoutSubscriberId = {
        ...mock.ctx,
        request: {
          ...mock.ctx.request,
          url: 'wss://test.lumenize.com/ws' // No subscriberId parameter
        }
      };
      
      // Call getConnectionTags directly with the modified context
      const tags = instance.getConnectionTags(mock.connection, mockContextWithoutSubscriberId);
      
      // Should return unauthenticated tag when subscriberId is missing
      expect(tags).toEqual(['unauthenticated']);
    });
  });
});
