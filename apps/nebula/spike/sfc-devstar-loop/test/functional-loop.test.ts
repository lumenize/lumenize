import { describe, it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';

// Exercises the full chain: SELF.fetch → Worker default fetch handler →
// routeDORequest → SpikeGalaxy.fetch. Correctness only — no timing
// assertions. Wall-clock timing measurement is the follow-on phase
// (node.js client → wrangler dev, then node.js → deployed Worker).

const SIMPLE_SFC = `<template>
  <div>{{ count }}</div>
</template>

<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>`;

describe('functional loop: WS register → compile → reload broadcast', () => {
  it('a single preview client receives reload after compile', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;

    // 1. Open the preview client's WS.
    const wsResponse = await SELF.fetch(
      `https://example.com/galaxy/spike/reload/${sessionId}`,
      { headers: { 'Upgrade': 'websocket' } },
    );
    expect(wsResponse.status).toBe(101);
    expect(wsResponse.webSocket).toBeDefined();

    const ws = wsResponse.webSocket!;
    ws.accept();

    const receivedMessages: string[] = [];
    ws.addEventListener('message', (event) => {
      receivedMessages.push(event.data as string);
    });

    // 2. POST the compile trigger.
    const compileResponse = await SELF.fetch(
      `https://example.com/galaxy/spike/compile/${sessionId}`,
      {
        method: 'POST',
        body: SIMPLE_SFC,
      },
    );
    expect(compileResponse.status).toBe(200);

    const result = await compileResponse.json() as {
      compiled: { script: number; template: number; styles: number; errors: string[] };
      notifiedPeers: number;
    };
    expect(result.compiled.errors).toEqual([]);
    expect(result.notifiedPeers).toBe(1);

    // 3. Verify the WS received 'reload'.
    await vi.waitFor(() => {
      expect(receivedMessages).toContain('reload');
    });

    ws.close();
  });

  it('only the matching sessionId receives reload (isolation)', async () => {
    const sessionA = `sess-A-${crypto.randomUUID()}`;
    const sessionB = `sess-B-${crypto.randomUUID()}`;

    // Open WS connections for both sessions.
    const respA = await SELF.fetch(
      `https://example.com/galaxy/spike/reload/${sessionA}`,
      { headers: { 'Upgrade': 'websocket' } },
    );
    const respB = await SELF.fetch(
      `https://example.com/galaxy/spike/reload/${sessionB}`,
      { headers: { 'Upgrade': 'websocket' } },
    );
    const wsA = respA.webSocket!;
    const wsB = respB.webSocket!;
    wsA.accept();
    wsB.accept();

    const messagesA: string[] = [];
    const messagesB: string[] = [];
    wsA.addEventListener('message', (e) => { messagesA.push(e.data as string); });
    wsB.addEventListener('message', (e) => { messagesB.push(e.data as string); });

    // Compile against session A only.
    const compileResponse = await SELF.fetch(
      `https://example.com/galaxy/spike/compile/${sessionA}`,
      { method: 'POST', body: SIMPLE_SFC },
    );
    const result = await compileResponse.json() as { notifiedPeers: number };
    expect(result.notifiedPeers).toBe(1);

    // Session A should receive reload; session B should NOT.
    await vi.waitFor(() => {
      expect(messagesA).toContain('reload');
    });

    // Give B a fair chance to receive — confirm it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messagesB).toEqual([]);

    wsA.close();
    wsB.close();
  });

  it('multiple peers on the same sessionId all receive reload (fanout)', async () => {
    const sessionId = `sess-fanout-${crypto.randomUUID()}`;

    const peers = await Promise.all(
      [0, 1, 2].map(() =>
        SELF.fetch(`https://example.com/galaxy/spike/reload/${sessionId}`, {
          headers: { 'Upgrade': 'websocket' },
        }),
      ),
    );

    const sockets = peers.map((r) => r.webSocket!);
    const messagesByPeer: string[][] = sockets.map(() => []);
    sockets.forEach((ws, idx) => {
      ws.accept();
      ws.addEventListener('message', (e) => { messagesByPeer[idx].push(e.data as string); });
    });

    const compileResponse = await SELF.fetch(
      `https://example.com/galaxy/spike/compile/${sessionId}`,
      { method: 'POST', body: SIMPLE_SFC },
    );
    const result = await compileResponse.json() as { notifiedPeers: number };
    expect(result.notifiedPeers).toBe(3);

    await vi.waitFor(() => {
      for (const msgs of messagesByPeer) {
        expect(msgs).toContain('reload');
      }
    });

    sockets.forEach((ws) => ws.close());
  });
});
