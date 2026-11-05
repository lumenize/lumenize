/**
 * Multi-node Lumenize Mesh test: Collaborative Document Editor
 *
 * This single long-running test simulates realistic multi-client collaboration
 * on a shared document, exercising the full mesh architecture from
 * website/docs/mesh/getting-started.mdx
 *
 * Scenarios covered:
 * 1. Alice connects, creates a document and opens it (receives empty content)
 * 2. Alice updates the document
 * 3. Alice shares it with Bob, who connects, opens it, and receives the current content
 * 4. Bob updates the document, both clients receive the broadcast
 * 5. Spell check findings go only to the originator (Bob, not Alice)
 *
 * Alice and Bob log in on their workspace's page through Mesh's Registry, which hands the magic
 * link back in test mode (ADR-009 rung 2).
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { EditorClient } from './editor-client.js';
import type { SpellFinding } from './spell-check-worker.js';
import type { DocumentDO } from './document-do.js';
import { loginAt, uniqueScope } from '../../support/login.js';

it('collaborative document editing with multiple clients', async () => {
  // A document is named by an id, never by a scope: a UUID
  const documentId = crypto.randomUUID();
  const workspace = uniqueScope('acme');

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
  const aliceLogin = await loginAt(workspace);
  const browser = new Browser();
  const aliceCtx = browser.context(aliceLogin.baseUrl);

  // ============================================
  // Example code - this is what we show in docs
  // ============================================

  // Use `using` for automatic cleanup via Symbol.dispose
  using client = new EditorClient({
    baseUrl: aliceLogin.baseUrl,
    refresh: aliceLogin.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: aliceCtx.sessionStorage,
    BroadcastChannel: aliceCtx.BroadcastChannel,
  });

  await vi.waitFor(() => {
    expect(client.connectionState).toBe('connected');
  });

  await client.createDocument(documentId);
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
  const bobLogin = await loginAt(workspace);
  await client.shareDocument(documentId, bobLogin.sub);
  const bobBrowser = new Browser();
  const bobCtx = bobBrowser.context(bobLogin.baseUrl);

  using bob = new EditorClient({
    baseUrl: bobLogin.baseUrl,
    refresh: bobLogin.refresh,
    fetch: bobBrowser.fetch,
    WebSocket: bobBrowser.WebSocket,
    sessionStorage: bobCtx.sessionStorage,
    BroadcastChannel: bobCtx.BroadcastChannel,
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
    const subscribers = await docClient.ctx.storage.kv.get<Array<{ instanceName: string; sub: string }>>('subscribers');
    expect(subscribers!.find((s) => s.instanceName === `${workspace}/${bob.lmz.instanceName}`)?.sub).toBe(bobLogin.sub);
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
