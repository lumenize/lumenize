import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { RpcBatchRequest, RpcBatchResponse } from '@lumenize/rpc';
import { stringify, parse } from '@lumenize/structured-clone';

/**
 * Every function in a method's result crosses the wire as a remote function
 * marker whose operation chain leads back to it.
 *
 * Reads the raw wire answer rather than a client's proxies, so a marker's
 * chain is asserted as sent. Needs no running system: the marker is built in
 * the Durable Object that answers the call, which this lane runs for real.
 */

// Lists every marker in a decoded result as `where → chain`, where `where`
// is the path a reader takes to it and `chain` is the marker's own chain.
function collectMarkers(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: any, where: string): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.__isRemoteFunction === true) {
      const chain = value.__operationChain
        .map((op: any) => (op.type === 'get' ? `get ${JSON.stringify(op.key)}` : `apply ${JSON.stringify(op.args)}`))
        .join(' / ');
      out.push(`${where} → ${value.__functionName}: ${chain}`);
      return;
    }
    if (value instanceof Map) {
      for (const [k, v] of value) visit(v, `${where}<${String(k)}>`);
    } else if (value instanceof Set) {
      for (const v of value) visit(v, `${where}<member>`);
    } else {
      for (const k of Object.keys(value)) visit(value[k], `${where}.${k}`);
    }
  };
  visit(root, '$');
  return out;
}

async function callForResult(instance: string, operations: RpcBatchRequest['batch'][0]['operations']) {
  const request: RpcBatchRequest = { batch: [{ id: 'call-1', operations }] };
  const response = await SELF.fetch(new Request(`https://example.com/__rpc/example-do/${instance}/call`, {
    method: 'POST',
    body: stringify(request),
    headers: { 'Content-Type': 'application/json' },
  }));
  const data = parse(await response.text()) as RpcBatchResponse;
  expect(data.batch[0].success).toBe(true);
  return data.batch[0].result;
}

describe('remote function markers', () => {
  it('marks a function in every place a result can hold one, keeping identity', async () => {
    const result = await callForResult('function-places', [
      { type: 'get', key: 'getFunctionPlaces' },
      { type: 'apply', args: ['places'] },
    ]);

    // Captured from the codec's transform hook on 2026-10-14, before rpc built
    // its own markers. A function inside a Map or Set value keeps a chain
    // that ends at the container, since a chain has no step into one.
    const base = 'get "getFunctionPlaces" / apply ["places"]';
    expect(collectMarkers(result)).toEqual([
      `$.plain.innerFn → innerFn: ${base} / get "plain" / get "innerFn"`,
      `$.list.1 → listFn: ${base} / get "list" / get 1`,
      `$.model.getValue → getValue: ${base} / get "model" / get "getValue"`,
      `$.model.getName → getName: ${base} / get "model" / get "getName"`,
      `$.model.compute → compute: ${base} / get "model" / get "compute"`,
      `$.byKey<fn> → mapFn: ${base} / get "byKey"`,
      `$.byKey<obj>.deepFn → deepFn: ${base} / get "byKey" / get "deepFn"`,
      `$.members<member> → setFn: ${base} / get "members"`,
      `$.first.sharedFn → sharedFn: ${base} / get "first" / get "sharedFn"`,
    ]);
    expect(result.self).toBe(result);
    expect(result.second).toBe(result.first);
  });

  it('answers each call with its result as it returned, not as a later call left it', async () => {
    const request: RpcBatchRequest = {
      batch: [
        { id: 'read', operations: [{ type: 'get', key: 'getLiveState' }, { type: 'apply', args: [] }] },
        { id: 'bump', operations: [{ type: 'get', key: 'bumpLiveState' }, { type: 'apply', args: [] }] },
      ],
    };
    const response = await SELF.fetch(new Request('https://example.com/__rpc/example-do/live-state/call', {
      method: 'POST',
      body: stringify(request),
      headers: { 'Content-Type': 'application/json' },
    }));
    const data = parse(await response.text()) as RpcBatchResponse;
    expect(data.batch[0].result).toEqual({ n: 0 });
    expect(data.batch[1].result).toBe(1);
  });
});
