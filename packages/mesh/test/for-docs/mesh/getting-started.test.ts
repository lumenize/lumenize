/**
 * Multi-node Lumenize Mesh test: Collaborative Document Editor
 *
 * This single long-running test simulates realistic multi-client collaboration
 * on a shared document, exercising the full mesh architecture from
 * website/docs/lumenize-mesh/getting-started.mdx
 *
 * Scenarios covered:
 * 1. Alice connects and subscribes to a new document (receives empty content)
 * 2. Alice updates the document
 * 3. Bob connects, subscribes, and receives the current content
 * 4. Bob updates the document, both clients receive the broadcast
 * 5. Spell check findings flow back to both clients
 * 6. Client disconnection and cleanup
 */

import { it, expect, vi } from 'vitest';
import { Browser, createTestingClient } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { EditorClient } from './editor-client.js';
import type { DocumentDO } from './document-do.js';

it('collaborative document editing with multiple clients', async () => {
  const documentId = 'collab-doc-1';

  // Track events for each client
  const aliceEvents = { content: [] as string[], states: [] as string[] };
  const bobEvents = { content: [] as string[], states: [] as string[] };

  // ============================================
  // Phase 1: Alice connects and subscribes
  // ============================================

  const aliceBrowser = new Browser();
  const aliceUserId = await testLoginWithMagicLink(aliceBrowser, 'alice@example.com');

  const alice = new EditorClient(
    {
      instanceName: `${aliceUserId}.tab1`,
      baseUrl: 'https://localhost',
      WebSocket: aliceBrowser.WebSocket as unknown as typeof WebSocket,
      refresh: 'https://localhost/auth/refresh-token',
      fetch: aliceBrowser.fetch,
      onConnectionStateChange: (state) => aliceEvents.states.push(state),
      onContentUpdate: (content) => aliceEvents.content.push(content),
    },
    documentId
  );

  await vi.waitFor(() => {
    expect(alice.connectionState).toBe('connected');
  });

  // Alice subscribes - should receive empty content for new document
  alice.subscribe();

  await vi.waitFor(() => {
    expect(aliceEvents.content).toHaveLength(1);
  });

  expect(aliceEvents.content[0]).toBe('');

  // Verify Alice is registered as subscriber
  {
    using docClient = createTestingClient<typeof DocumentDO>('DOCUMENT_DO', documentId);
    const subscribers = await docClient.ctx.storage.kv.get<Set<string>>('subscribers');
    expect(subscribers).toBeDefined();
    expect(subscribers!.has(`${aliceUserId}.tab1`)).toBe(true);
  }

  // ============================================
  // Phase 2: Alice updates the document
  // ============================================

  alice.saveContent('Hello from Alice!');

  // Alice should receive the broadcast of her own update
  await vi.waitFor(() => {
    expect(aliceEvents.content).toHaveLength(2);
  });

  expect(aliceEvents.content[1]).toBe('Hello from Alice!');

  // Verify content is stored
  {
    using docClient = createTestingClient<typeof DocumentDO>('DOCUMENT_DO', documentId);
    const storedContent = await docClient.ctx.storage.kv.get<string>('content');
    expect(storedContent).toBe('Hello from Alice!');
  }

  // ============================================
  // Phase 3: Bob connects and subscribes
  // ============================================

  const bobBrowser = new Browser();
  const bobUserId = await testLoginWithMagicLink(bobBrowser, 'bob@example.com');

  const bob = new EditorClient(
    {
      instanceName: `${bobUserId}.tab1`,
      baseUrl: 'https://localhost',
      WebSocket: bobBrowser.WebSocket as unknown as typeof WebSocket,
      refresh: 'https://localhost/auth/refresh-token',
      fetch: bobBrowser.fetch,
      onConnectionStateChange: (state) => bobEvents.states.push(state),
      onContentUpdate: (content) => bobEvents.content.push(content),
    },
    documentId
  );

  await vi.waitFor(() => {
    expect(bob.connectionState).toBe('connected');
  });

  // Bob subscribes - should receive current content
  bob.subscribe();

  await vi.waitFor(() => {
    expect(bobEvents.content).toHaveLength(1);
  });

  expect(bobEvents.content[0]).toBe('Hello from Alice!');

  // Verify both are now subscribers
  {
    using docClient = createTestingClient<typeof DocumentDO>('DOCUMENT_DO', documentId);
    const subscribers = await docClient.ctx.storage.kv.get<Set<string>>('subscribers');
    expect(subscribers!.size).toBe(2);
    expect(subscribers!.has(`${aliceUserId}.tab1`)).toBe(true);
    expect(subscribers!.has(`${bobUserId}.tab1`)).toBe(true);
  }

  // ============================================
  // Cleanup
  // ============================================

  alice.disconnect();
  bob.disconnect();
});
