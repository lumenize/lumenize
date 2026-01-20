/**
 * End-to-end tests for the collaborative document editor from getting-started.mdx
 *
 * These tests use @lumenize/testing's Browser.WebSocket to connect
 * through vitest-pool-workers to actual DOs running in the test environment.
 *
 * This validates the code examples in website/docs/lumenize-mesh/getting-started.mdx
 */

import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { signJwt, importPrivateKey, createJwtPayload } from '@lumenize/auth';
import { LumenizeClient, mesh } from '../../../src/index.js';
import type { DocumentDO, SpellFinding } from './test-worker';

// ============================================
// Test Helpers
// ============================================

/**
 * Generate a valid JWT access token for testing
 */
async function generateTestToken(userId: string): Promise<string> {
  const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
  const payload = createJwtPayload({
    issuer: 'test',
    audience: 'test',
    subject: userId,
    expiresInSeconds: 3600, // 1 hour
  });
  return signJwt(payload, privateKey, 'BLUE');
}

// ============================================
// EditorClient - Browser client implementation
// ============================================

/**
 * Test implementation of the EditorClient from getting-started.mdx
 */
class EditorClient extends LumenizeClient {
  // Track incoming calls for testing
  contentUpdates: string[] = [];
  spellFindings: SpellFinding[][] = [];
  #documentId: string;

  constructor(
    config: ConstructorParameters<typeof LumenizeClient>[0],
    documentId: string
  ) {
    super(config);
    this.#documentId = documentId;
  }

  // Called by DocumentDO when content changes
  @mesh
  handleContentUpdate(content: string) {
    this.contentUpdates.push(content);
  }

  // Called by DocumentDO with spell check results
  @mesh
  handleSpellFindings(findings: SpellFinding[]) {
    this.spellFindings.push(findings);
  }

  // Called when reconnecting after grace period expired
  onSubscriptionsLost = () => {
    this.#subscribe();
  };

  // Public method for tests to save content
  saveContent(content: string) {
    const remote = this.ctn<DocumentDO>().update(content);
    this.lmz.call(
      'DOCUMENT_DO',
      this.#documentId,
      remote
    );
  }

  // Subscribe to document updates
  subscribe() {
    this.#subscribe();
  }

  #subscribe() {
    const remote = this.ctn<DocumentDO>().subscribe();
    const callback = this.ctn<EditorClient>().handleSubscribeResult(remote);
    this.lmz.call(
      'DOCUMENT_DO',
      this.#documentId,
      remote,
      callback
    );
  }

  // Response handler for subscribe - receives result or Error
  @mesh
  handleSubscribeResult(result: any) {
    if (result instanceof Error) {
      console.error('Failed to subscribe:', result);
      return;
    }
    this.contentUpdates.push(result);
  }
}

// ============================================
// Tests
// ============================================

describe('Getting Started - Collaborative Document Editor', () => {
  describe('Connection', () => {
    it('connects to Gateway using Browser.WebSocket', async () => {
      const browser = new Browser();
      const states: string[] = [];
      const userId = 'testuser';
      const accessToken = await generateTestToken(userId);

      const client = new EditorClient(
        {
          instanceName: `${userId}.tab1`,
          baseUrl: 'https://example.com',
          WebSocket: browser.WebSocket as unknown as typeof WebSocket,
          accessToken,
          onConnectionStateChange: (state) => {
            states.push(state);
          },
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
