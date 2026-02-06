/**
 * Multi-node Lumenize Mesh test: Collaborative Document Editor
 *
 * This single long-running test simulates realistic multi-client collaboration
 * on a shared document, exercising the full mesh architecture from
 * website/docs/mesh/getting-started.mdx
 *
 * Scenarios covered:
 * 1. Alice connects and opens a document (receives empty content)
 * 2. Alice updates the document
 * 3. Bob connects, opens the same document, and receives the current content
 * 4. Bob updates the document, both clients receive the broadcast
 * 5. Spell check findings go only to the originator (Bob, not Alice)
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { testLoginWithMagicLink } from '@lumenize/auth';
import { EditorClient } from './editor-client.js';
import type { SpellFinding } from './spell-check-worker.js';
import type { DocumentDO } from './document-do.js';

it('collaborative document editing with multiple clients', async () => {
  const documentId = 'collab-doc-1';

  // ============================================
  // Test infrastructure - tracks events for assertions
  // ============================================
  const events = { content: [] as string[], spellFindings: [] as SpellFinding[][] };
  const bobEvents = { content: [] as string[], spellFindings: [] as SpellFinding[][] };

  // Simulate UI update functions (in a real app, these would update the DOM)
  function updateEditor(content: string) { events.content.push(content); }
  function showSpellingSuggestions(findings: SpellFinding[]) { events.spellFindings.push(findings); }
  function updateBobEditor(content: string) { bobEvents.content.push(content); }
  function showBobSpellingSuggestions(findings: SpellFinding[]) { bobEvents.spellFindings.push(findings); }

  // ============================================
  // Test setup - authenticate user
  // ============================================
  const browser = new Browser();
  const { sub: userId } = await testLoginWithMagicLink(browser, 'alice@example.com', { subjectData: { adminApproved: true } });

  // ============================================
  // Example code - this is what we show in docs
  // ============================================

  // Use `using` for automatic cleanup via Symbol.dispose
  using client = new EditorClient({
    instanceName: `${userId}.tab1`,  // From auth context (JWT sub claim)
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(client.connectionState).toBe('connected');
  });

  const doc = client.openDocument(documentId, {
    onContentUpdate: updateEditor,
    onSpellFindings: showSpellingSuggestions,
  });

  await vi.waitFor(() => {
    expect(events.content[0]).toBe('');
  });

  doc.saveContent('The quick brown fox');

  await vi.waitFor(() => {
    expect(events.content[1]).toBe('The quick brown fox');
  });

  // Cleanup: close document handles (clients auto-disconnect via `using`)
  doc.close();

  // ============================================
  // Additional test: second client (Bob) joins
  // ============================================
  const bobBrowser = new Browser();
  const { sub: bobUserId } = await testLoginWithMagicLink(bobBrowser, 'bob@example.com', { subjectData: { adminApproved: true } });

  using bob = new EditorClient({
    instanceName: `${bobUserId}.tab1`,
    baseUrl: 'https://localhost',
    refresh: 'https://localhost/auth/refresh-token',
    fetch: bobBrowser.fetch,
    WebSocket: bobBrowser.WebSocket,
  });

  await vi.waitFor(() => {
    expect(bob.connectionState).toBe('connected');
  });

  const bobDoc = bob.openDocument(documentId, {
    onContentUpdate: updateBobEditor,
    onSpellFindings: showBobSpellingSuggestions,
  });

  await vi.waitFor(() => {
    expect(bobEvents.content[0]).toBe('The quick brown fox');
  });

  // Reopen first client's document for broadcast test
  const doc2 = client.openDocument(documentId, {
    onContentUpdate: updateEditor,
    onSpellFindings: showSpellingSuggestions,
  });

  // Verify Bob is subscribed via direct storage inspection
  {
    using docClient = createTestingClient<typeof DocumentDO>('DOCUMENT_DO', documentId);
    const subscribers = await docClient.ctx.storage.kv.get<Set<string>>('subscribers');
    expect(subscribers).toBeInstanceOf(Set);
    expect(subscribers!.has(`${bobUserId}.tab1`)).toBe(true);
  }

  // Bob continues the document, both receive the broadcast
  bobDoc.saveContent('The quick brown fox jumps over teh lazy dog.');

  // Both clients should receive the broadcast
  await vi.waitFor(() => {
    expect(events.content.at(-1)).toBe('The quick brown fox jumps over teh lazy dog.');
    expect(bobEvents.content.at(-1)).toBe('The quick brown fox jumps over teh lazy dog.');
  });

  // Spell check findings go only to the originator
  // The spell checker sends results directly to the client who made the update.
  // Only Bob should receive findings (he made the update with "teh").
  await vi.waitFor(() => {
    expect(bobEvents.spellFindings.length).toBeGreaterThan(0);
  });

  // First client should NOT receive spell findings (they didn't make this update)
  expect(events.spellFindings.length).toBe(0);

  // Verify Bob's findings
  const bobFindings = bobEvents.spellFindings.at(-1)!;
  expect(bobFindings[0].word).toBe('teh');
  expect(bobFindings[0].suggestions).toContain('the');

  // Cleanup
  doc2.close();
  bobDoc.close();
});
