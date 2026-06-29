/**
 * Resilient chat-turn delivery — tasks/resilient-turn-delivery.md
 *
 * `NebulaClient.chat()` fires a codegen turn at DevStudio ONE-WAY (not an awaited
 * `callRaw`) and resolves when DevStudio delivers the result back via the
 * `onChatResult` push — direct delivery addressed to this client's stable
 * `instanceName`, so a WS drop+reconnect mid-turn no longer strands the reply (the
 * "Studio is thinking… forever" bug). See [[client-calls-use-direct-delivery]].
 *
 * DevStudio.chat itself needs `env.AI` + a live container (the `ui-smoke` lane), so
 * here we exercise the mechanism through the full client↔Gateway↔DO path with a
 * stand-in (`StarTest.runFakeTurn` echoes `onChatResult`; `StarTest.callClient`
 * delivers a raw `onChatResult`). The server-side `DevStudio.deliverTurnResult` uses
 * the identical `lmz.call('NEBULA_CLIENT_GATEWAY', clientId, ctn<NebulaClient>().onChatResult(...))`
 * shape as Star's result callbacks (already integration-tested).
 *
 * Mutation-validated (testing.md): commenting out the `pending.resolve(...)` in
 * `NebulaClient.onChatResult` reddens all three tests (each promise then never
 * settles → timeout); the turnId-correlation test independently reddens if
 * `onChatResult` ignores `turnId` and resolves the pending turn unconditionally
 * (the bogus 'WRONG' delivery would settle it first).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createAuthenticatedClient, ORIGIN } from '../../test-helpers';
import { NebulaClientTest } from './index';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

describe('nebula-client resilient chat-turn delivery', () => {

  it('chat() round-trips: fires the turn one-way and resolves via onChatResult', async () => {
    const star = uniqueStar();
    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    const result = await a.client.chatViaStarForTest(star, 'build a todo app');

    expect(result).toEqual({ reply: 'echo: build a todo app', thought: 'thought: build a todo app' });
  });

  it('onChatResult settles only the matching turnId; an unknown turnId is ignored', async () => {
    const star = uniqueStar();
    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const clientId = a.client.lmz.instanceName;

    const turnId = generateUuid();
    const pending = a.client.registerPendingTurnForTest(turnId);

    // Deliver for a DIFFERENT turnId first — must NOT settle our pending turn (if
    // onChatResult ignored turnId, this 'WRONG' payload would resolve it first).
    a.client.triggerOnChatResultForTest(star, clientId, generateUuid(), 'WRONG', 'WRONG');
    // Then deliver for the real turnId.
    a.client.triggerOnChatResultForTest(star, clientId, turnId, 'right', 'rt');

    await expect(pending).resolves.toEqual({ reply: 'right', thought: 'rt' });
  });

  it('a pending turn survives a WS reconnect and is settled by onChatResult on the new socket', async () => {
    const star = uniqueStar();
    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    // Register the pending turn BEFORE the drop — it lives in #pendingTurns (memory),
    // which a transient reconnect does NOT clear (only an explicit disconnect() does).
    const turnId = generateUuid();
    const pending = a.client.registerPendingTurnForTest(turnId);

    // Force a reconnect via the Gateway supersede mechanism (same trick as 5.3.4a):
    // a 2nd client with the same instanceName + accessToken makes the Gateway close
    // a.client's socket (4409), and a.client auto-reconnects on a new socket.
    const aInstanceName = a.client.lmz.instanceName;
    const browserB = new Browser();
    const b = new NebulaClientTest({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: 'v1',
      instanceName: aInstanceName,
      accessToken: a.accessToken,
      fetch: browserB.fetch,
      WebSocket: browserB.WebSocket,
    });
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('reconnecting'); });
    b.disconnect(); // stop b before it ping-pongs with a.client's reconnect
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('connected'); });

    // Deliver the result AFTER the reconnect — addressed by instanceName, it must land
    // on the NEW socket (an awaited callRaw bound to the original socket would not).
    a.client.triggerOnChatResultForTest(star, aInstanceName, turnId, 'late reply', 'late thought');

    await expect(pending).resolves.toEqual({ reply: 'late reply', thought: 'late thought' });
  });

});
