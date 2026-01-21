/**
 * Multi-node (DOs, Workers, Clients, Auth, etc.) Lumenize Mesh test implementing
 * the collaborative document editor from website/docs/mesh/getting-started.mdx
 *
 * These tests use the full auth flow with LumenizeAuth magic links and Browser
 * cookie handling, demonstrating the realistic pattern users will follow.
 */

import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { EditorClient } from './editor-client.js';

// ============================================
// Tests
// ============================================

describe('Getting Started - Collaborative Document Editor', () => {
  describe('Connection with full auth flow', () => {
    it('connects via magic link login and Browser cookies', async () => {
      const browser = new Browser();
      const states: string[] = [];

      // Full auth flow: magic link -> cookie -> access token
      const userId = await testLoginWithMagicLink(browser, 'alice@example.com');

      const client = new EditorClient(
        {
          instanceName: `${userId}.tab1`,
          baseUrl: 'https://localhost',
          // Inject Browser's WebSocket which includes cookies
          WebSocket: browser.WebSocket as unknown as typeof WebSocket,
          // Refresh endpoint URL (must be absolute for fetch to work)
          refresh: 'https://localhost/auth/refresh-token',
          // Browser's fetch includes cookies
          fetch: browser.fetch,
          onConnectionStateChange: (state) => states.push(state),
        },
        'test-doc-1'
      );

      // Wait for connection to establish
      await vi.waitFor(() => {
        expect(client.connectionState).toBe('connected');
      }, { timeout: 5000 });

      expect(states).toContain('connecting');
      expect(states).toContain('connected');

      client.disconnect();
    });
  });

  // TODO: Add more tests incrementally and interactively:
  // - Test subscribing to DocumentDO and receiving initial content
  // - Test saving content and receiving broadcast updates
  // - Test spell check findings flowing back to client
  // - Test multiple clients receiving broadcasts
  // - Test onSubscriptionsLost callback
  // - Test onLoginRequired callback
});
