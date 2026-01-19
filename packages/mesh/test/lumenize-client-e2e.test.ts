/**
 * End-to-end tests for LumenizeClient with actual mesh integration
 *
 * These tests use @lumenize/testing's Browser.WebSocket to connect
 * through vitest-pool-workers to actual DOs running in the test environment.
 *
 * This file is a stub - tests will be built out incrementally and interactively.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { signJwt, importPrivateKey, createJwtPayload } from '@lumenize/auth';
import { LumenizeClient, mesh } from '../src/index.js';
import type { EchoDO } from './test-worker-and-dos';

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
// Test Client Implementation
// ============================================

/**
 * Simple test client that can connect to the Gateway
 */
class TestEditorClient extends LumenizeClient {
  // Track incoming calls for testing
  receivedMessages: string[] = [];

  @mesh
  handleContentUpdate(content: string) {
    this.receivedMessages.push(content);
  }

  // Public method to call EchoDO
  async echoMessage(message: string): Promise<{ message: string; origin?: any }> {
    return await this.lmz.callRaw(
      'ECHO_DO',
      'test-echo-instance',
      this.ctn<EchoDO>().echo(message)
    );
  }
}

// ============================================
// Tests
// ============================================

describe('LumenizeClient E2E', () => {
  describe('Connection', () => {
    it('connects to Gateway using Browser.WebSocket', async () => {
      const browser = new Browser();
      const states: string[] = [];
      const userId = 'testuser';
      const accessToken = await generateTestToken(userId);

      const client = new TestEditorClient({
        instanceName: `${userId}.tab1`,
        baseUrl: 'https://example.com',
        // Browser.WebSocket uses SELF.fetch internally
        WebSocket: browser.WebSocket as unknown as typeof WebSocket,
        // Use a real JWT signed with test keys
        accessToken,
        onConnectionStateChange: (state) => {
          states.push(state);
        },
      });

      // Wait for connection to establish
      await vi.waitFor(() => {
        expect(client.connectionState).toBe('connected');
      }, { timeout: 5000 });

      expect(states).toContain('connecting');
      expect(states).toContain('connected');

      client.disconnect();
    });

    // TODO: Add more tests incrementally:
    // - Test calling EchoDO and receiving response
    // - Test receiving incoming calls from DO
    // - Test reconnection after disconnect
    // - Test subscription updates
  });
});
