import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

interface ProbeResult {
  name: string | null;
  id: string;
}

async function openWS(path: string): Promise<{ ws: WebSocket; fetchName: string | null; id: string }> {
  const res = await SELF.fetch(`http://probe${path}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  expect(ws).toBeDefined();
  ws!.accept();
  return {
    ws: ws!,
    fetchName: res.headers.get('X-Probe-Fetch-Name'),
    id: res.headers.get('X-Probe-Fetch-Id')!,
  };
}

function sendAndReceive(ws: WebSocket): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ws message timeout')), 5000);
    ws.addEventListener('message', (e) => {
      clearTimeout(timeout);
      resolve(JSON.parse(e.data as string));
    }, { once: true });
    ws.send('what is your name?');
  });
}

describe('ctx.id.name in WebSocket handlers', () => {
  it('Probe A: getByName access — same access path', async () => {
    const name = 'hello-' + crypto.randomUUID();
    const { ws, fetchName, id } = await openWS(`/upgrade-by-name?name=${name}`);
    console.log(`[A] fetch ctx.id.name = ${fetchName}, id = ${id}`);

    const result = await sendAndReceive(ws);
    console.log(`[A] webSocketMessage ctx.id.name = ${result.name}`);

    expect(result.id).toBe(id);
    // Sanity: both fetch and ws-message should see the name in this in-memory case
    expect(fetchName).toBe(name);
    expect(result.name).toBe(name);
  });

  it('Probe B (LOAD-BEARING): reconnect via idFromString', async () => {
    const name = 'hello-' + crypto.randomUUID();

    // Step 1: prime DO via getByName
    const first = await openWS(`/upgrade-by-name?name=${name}`);
    const id = first.id;
    console.log(`[B] step 1 — first access via getByName, id = ${id}, fetch name = ${first.fetchName}`);
    first.ws.close();

    // Step 2: reconnect via idFromString — this access path has NO name
    const second = await openWS(`/upgrade-by-id?id=${id}`);
    console.log(`[B] step 2 — reconnect via idFromString, fetch ctx.id.name = ${second.fetchName}`);

    const result = await sendAndReceive(second.ws);
    console.log(`[B] step 2 — webSocketMessage ctx.id.name = ${result.name}`);
    console.log(
      result.name === name
        ? `[B] RESULT: CF persists name in DO metadata (available across access paths)`
        : `[B] RESULT: name is per-access only (not persisted)`
    );

    // No assertion — this is the question we're answering. Log both possibilities.
    expect(result.id).toBe(id);
  });
});
