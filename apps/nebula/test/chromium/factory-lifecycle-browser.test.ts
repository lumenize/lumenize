/**
 * Factory connection-lifecycle — ONE narrative real-chromium / real-WS test.
 *
 * Per the magic-link e2e convention (one slow email bootstrap amortized over
 * many sequential steps, destructive step last), this single test strings
 * together what would otherwise be four separate real-Star tests:
 *
 *   1. CONNECTIVITY + bundle regression — `@lumenize/nebula/frontend` bundles
 *      for real chromium (Vite would fail on any transitive cloudflare:workers /
 *      node:async_hooks import), the factory connects through the proxy to a real
 *      Star, and `ready` resolves with claims populated + `lmz.connection` connected.
 *   2. PATH 4 — mid-session drop → reconnect: `connected`→`reconnecting`→`connected`;
 *      `lastConnectedAt` never cleared while reconnecting; banner state is
 *      `reconnecting`, NOT a fresh `connecting` flash (the four states stay distinct).
 *   3. orgTree survives the reconnect: after reconnecting, a `client.orgTree`
 *      mutation still echoes to `store.lmz.orgTree` (NebulaClient re-fires
 *      `subscribeTree` on every `'connected'`). End-to-end resilience, not a
 *      re-subscribe-line isolation (a TreeSubscribers row persists across a bare
 *      disconnect, and isolating the line needs a second independent actor
 *      mutating while this client is down — impossible single-page; that line is
 *      covered by the baseline `orgtree-factory-autosubscribe` + step 2's reconnect).
 *   4. PATH 5 — mid-session terminal (finale, destructive): the token is cleared
 *      (real "expired" precursor) and the refresh is revoked, so the reconnect's
 *      refresh 401s → terminal `LoginRequiredError` → `onLoginRequired` + state
 *      `disconnected` (NOT stuck `reconnecting`). `ready` (resolved in step 1)
 *      must NOT re-settle (the factory's `readySettled` guard).
 *
 * The drop is the synthetic-close `drop()` (drives the client's `#handleClose`
 * → reconnect). CDP network-offline was rejected: it severs the
 * browser↔vitest-server channel and hangs the run (see ws-disconnect.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { ROOT_NODE_ID } from '@lumenize/nebula/frontend';
import { bootstrapFactory } from './factory-harness';
import { recordingWebSocket, refresh401AfterFlag } from './ws-disconnect';

function nodeLabels(state: unknown): string[] {
  const nodes = (state as { nodes?: Map<number, { label: string }> } | undefined)?.nodes;
  if (!(nodes instanceof Map)) return [];
  return [...nodes.values()].map((n) => n.label);
}

describe('factory connection lifecycle (real chromium, real WS)', () => {
  it('connect → reconnect → orgTree-after-reconnect → terminal, in one session', async () => {
    const rec = recordingWebSocket();
    let revoked = false;
    const transitions: string[] = [];
    let loginRequiredCount = 0;

    const { client, store, ready, dispose } = await bootstrapFactory({
      WebSocket: rec.WebSocket,
      fetch: refresh401AfterFlag(() => revoked),
      onConnectionStateChange: (s) => transitions.push(s),
      onLoginRequired: () => { loginRequiredCount++; },
    });

    try {
      // ── Step 1: connectivity + bundle regression ──────────────────────────
      await ready;
      let readyRejected = false;
      ready.catch(() => { readyRejected = true; }); // already settled → must never reject
      expect(client.claims?.sub).toBeTruthy();
      await vi.waitFor(() => expect(store.lmz.connection.state).toBe('connected'), { timeout: 10000 });
      expect(store.lmz.connection.connected).toBe(true);
      expect(store.lmz.connection.lastConnectedAt).toBeTypeOf('number');
      // orgTree auto-subscribed on the initial connect.
      await vi.waitFor(() => {
        expect((store.lmz.orgTree.value as { nodes?: Map<number, unknown> } | undefined)?.nodes).toBeInstanceOf(Map);
      }, { timeout: 10000 });

      // ── Step 2: mid-session drop → reconnect (path 4) ─────────────────────
      const lastConnectedBefore = store.lmz.connection.lastConnectedAt as number;
      const socketsBefore = rec.count();
      transitions.length = 0; // only post-drop transitions matter for the conflation guard
      rec.drop();
      // 'reconnecting' (not cleared): lastConnectedAt holds its pre-drop value
      // while reconnecting. Both asserted in one tick to avoid a TOCTOU.
      await vi.waitFor(() => {
        expect(store.lmz.connection.state).toBe('reconnecting');
        expect(store.lmz.connection.lastConnectedAt).toBe(lastConnectedBefore);
      }, { timeout: 10000 });
      // Reconnects on a NEW socket.
      await vi.waitFor(() => expect(store.lmz.connection.state).toBe('connected'), { timeout: 15000 });
      expect(rec.count()).toBeGreaterThan(socketsBefore);
      expect(store.lmz.connection.connected).toBe(true);
      // Conflation guard: a reconnect uses 'reconnecting', never a 'connecting' flash.
      expect(transitions).toContain('reconnecting');
      expect(transitions).not.toContain('connecting');
      expect(transitions.at(-1)).toBe('connected');

      // ── Step 3: orgTree still delivers after the reconnect ────────────────
      const slug = `team-${crypto.randomUUID().slice(0, 8)}`;
      await client.orgTree.createNode(ROOT_NODE_ID, slug, 'AfterReconnect');
      await vi.waitFor(() => {
        expect(nodeLabels(store.lmz.orgTree.value)).toContain('AfterReconnect');
      }, { timeout: 10000 });

      // ── Step 4: mid-session terminal (finale, destructive) ────────────────
      // Clear the token (so the reconnect re-refreshes) + revoke the session (so
      // that refresh 401s). The reconnect then surfaces a terminal LoginRequired.
      revoked = true;
      client.clearAccessToken();
      rec.drop();
      await vi.waitFor(() => expect(store.lmz.connection.state).toBe('disconnected'), { timeout: 15000 });
      expect(loginRequiredCount).toBeGreaterThanOrEqual(1);
      expect(store.lmz.connection.state).toBe('disconnected'); // NOT stuck 'reconnecting'
      // no-double-settle: ready resolved in step 1 and must still be resolved.
      await expect(ready).resolves.toBeUndefined();
      expect(readyRejected).toBe(false);
    } finally {
      await dispose();
    }
  });
});
