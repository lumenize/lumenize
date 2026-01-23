/**
 * Multi-node Lumenize Mesh test: Collaborative Document Editor
 *
 * This single long-running test simulates realistic multi-client collaboration
 * on a shared document, exercising the full mesh architecture from
 * website/docs/lumenize-mesh/getting-started.mdx
 *
 * Scenarios covered:
 * 1. Alice connects and opens a document (receives empty content)
 * 2. Alice updates the document
 * 3. Bob connects, opens the same document, and receives the current content
 * 4. Bob updates the document, both clients receive the broadcast
 * 5. Spell check findings go only to the originator (Bob, not Alice)
 */

import { it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { EditorClient } from './editor-client.js';
import type { SpellFinding } from './spell-check-worker.js';

it('collaborative document editing with multiple clients', async () => {
  const documentId = 'collab-doc-1';

  // Track events for each client
  const aliceEvents = { content: [] as string[], spellFindings: [] as SpellFinding[][] };
  const bobEvents = { content: [] as string[], spellFindings: [] as SpellFinding[][] };

  // ============================================
  // Phase 1: Alice connects and opens a document
  // ============================================

  const aliceBrowser = new Browser();
  const aliceUserId = await testLoginWithMagicLink(aliceBrowser, 'alice@example.com');

  // Use `using` for automatic cleanup via Symbol.dispose
  using alice = new EditorClient({
    instanceName: `${aliceUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    // Test-specific: inject browser's fetch/WebSocket
    fetch: aliceBrowser.fetch,
    WebSocket: aliceBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(alice.connectionState).toBe('connected');
  });

  // Alice opens the document - should receive empty content for new document
  const aliceDoc = alice.openDocument(documentId, {
    onContentUpdate: (content) => aliceEvents.content.push(content),
    onSpellFindings: (findings) => aliceEvents.spellFindings.push(findings),
  });

  await vi.waitFor(() => {
    expect(aliceEvents.content[0]).toBe('');
  });

  // ============================================
  // Phase 2: Alice starts writing the document
  // ============================================

  aliceDoc.saveContent('The quick brown fox');

  // Alice should receive the broadcast of her own update
  await vi.waitFor(() => {
    expect(aliceEvents.content[1]).toBe('The quick brown fox');
  });

  // ============================================
  // Phase 3: Bob connects and opens the same document
  // ============================================

  const bobBrowser = new Browser();
  const bobUserId = await testLoginWithMagicLink(bobBrowser, 'bob@example.com');

  using bob = new EditorClient({
    instanceName: `${bobUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    // Test-specific: inject browser's fetch/WebSocket
    fetch: bobBrowser.fetch,
    WebSocket: bobBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(bob.connectionState).toBe('connected');
  });

  // Bob opens the same document - should receive current content
  const bobDoc = bob.openDocument(documentId, {
    onContentUpdate: (content) => bobEvents.content.push(content),
    onSpellFindings: (findings) => bobEvents.spellFindings.push(findings),
  });

  await vi.waitFor(() => {
    expect(bobEvents.content[0]).toBe('The quick brown fox');
  });

  // ============================================
  // Phase 4: Bob continues the document, both receive the broadcast
  // ============================================

  bobDoc.saveContent('The quick brown fox jumps over teh lazy dog.');

  // Both Alice and Bob should receive the broadcast
  await vi.waitFor(() => {
    expect(aliceEvents.content[2]).toBe('The quick brown fox jumps over teh lazy dog.');
    expect(bobEvents.content[1]).toBe('The quick brown fox jumps over teh lazy dog.');
  });

  // ============================================
  // Phase 5: Spell check findings go only to the originator
  // ============================================

  // The spell checker sends results directly to the client who made the update.
  // Only Bob should receive findings (he made the update with "teh").
  await vi.waitFor(() => {
    expect(bobEvents.spellFindings.length).toBeGreaterThan(0);
  });

  // Alice should NOT receive spell findings (she didn't make this update)
  expect(aliceEvents.spellFindings.length).toBe(0);

  // Verify Bob's findings
  const bobFindings = bobEvents.spellFindings.at(-1)!;
  expect(bobFindings[0].word).toBe('teh');
  expect(bobFindings[0].suggestions).toContain('the');

  // Cleanup: close document handles (clients auto-disconnect via `using`)
  aliceDoc.close();
  bobDoc.close();
});
