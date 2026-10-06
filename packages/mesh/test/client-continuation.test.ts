/**
 * A Client's result handler continuation travels with its call and comes back filled.
 *
 * Every limb drives a real `LumenizeClient` through the test Worker's real Gateway to a real node,
 * and asserts what the Client's own handler received. The properties are the mesh framework's — the
 * Client's response door, the Gateway's refusal fill — so this package's lane is where they live;
 * `apps/nebula`'s `forged-continuation` and `late-answer-dropped` scenarios drive the same doors live.
 */
import { describe, it, expect, vi } from 'vitest';
// For its side effect: `Browser`'s default fetch reaches the test Worker through `SELF`.
import 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { LumenizeClient } from '../src/lumenize-client';
import { createTestRefreshFunction } from '../src/create-test-refresh-function';
import type { TestDO } from './test-worker-and-dos';

/** An Error subclass that carries a property of its own, unregistered on `globalThis`. */
class BoundError extends Error {
  name = 'BoundError';
  code = 42;
}

/** A client whose handlers record what they received. They run as its own continuations, so no `@mesh()`. */
class ContinuationClient extends LumenizeClient {
  received: unknown[] = [];
  injected: string[] = [];
  callees: unknown[] = [];

  captureBound(map: Map<string, number>, date: Date, cyclic: object, aliasA: object, aliasB: object, error: Error, result?: unknown): void {
    this.received.push({ map, date, cyclic, aliasA, aliasB, error, result });
  }

  captureReply(result?: unknown): void {
    this.received.push(result);
  }

  recordCallee(result?: unknown): void {
    const { callee, callChain } = this.lmz.callContext;
    this.callees.push({ callee, origin: callChain[0], result });
  }

  /** What a marker-shaped answer names, if anything ever resolved it. */
  recordInjected(tag: string): string {
    this.injected.push(tag);
    return 'injected ran';
  }

  /** Genuine nesting: `seven()` is resolved before `withPrefix` runs, and its result is bound. */
  seven(): number {
    return 7;
  }

  withPrefix(prefix: number): { capture: (result?: unknown) => void } {
    return { capture: (result?: unknown) => { this.received.push({ prefix, result }); } };
  }

  /** The `callAsync` Promises this Client still keeps. */
  pendingAsync(): number {
    return this.pendingAsyncCallCount();
  }
}

async function connect(): Promise<ContinuationClient> {
  const sub = crypto.randomUUID();
  const browser = new Browser();
  const client = new ContinuationClient({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** A value shaped like a nested marker, as JSON — a string crosses the request leg unresolved. */
const markerShapedJson = (tag: string) => JSON.stringify({
  __isNestedOperation: true,
  __operationChain: [{ type: 'get', key: 'recordInjected' }, { type: 'apply', args: [tag] }],
  payload: `reply-${tag}`,
});

describe('a Client\'s result handler continuation travels with its call', () => {
  it('carries bound values back intact: a Map, a Date, a cycle, an alias and an Error subclass', async () => {
    using client = await connect();
    const map = new Map([['a', 1]]);
    const date = new Date('2026-10-05T12:00:00.000Z');
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const alias = { shared: true };
    const error = new BoundError('bound');
    const remote = client.ctn<TestDO>().remoteEcho('bound');
    client.lmz.call('TEST_DO', 'cc-bound', remote,
      client.ctn<ContinuationClient>().captureBound(map, date, cyclic, alias, alias, error, remote));

    await vi.waitFor(() => expect(client.received).toHaveLength(1));
    const got = client.received[0] as any;
    expect(got.map).toBeInstanceOf(Map);
    expect(got.map.get('a')).toBe(1);
    expect(got.date).toBeInstanceOf(Date);
    expect(got.date.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(got.cyclic.self).toBe(got.cyclic);
    expect(got.aliasA).toBe(got.aliasB);
    expect(got.error).toBeInstanceOf(Error);
    expect({ name: got.error.name, message: got.error.message, code: got.error.code })
      .toEqual({ name: 'BoundError', message: 'bound', code: 42 });
    expect(got.result).toBe('echo: bound');
  });

  it('refuses a bound function at the call site', async () => {
    using client = await connect();
    const remote = client.ctn<TestDO>().remoteEcho('fn');
    expect(() => client.lmz.call('TEST_DO', 'cc-fn', remote,
      client.ctn<ContinuationClient>().captureReply((() => 1) as unknown)))
      .toThrow(/A function cannot cross the mesh/);
    // A `callAsync` throws too, before it keeps a Promise that nothing would ever settle.
    expect(() => client.lmz.callAsync('TEST_DO', 'cc-fn',
      client.ctn<TestDO>().remoteEcho((() => 1) as unknown as string)))
      .toThrow(/A function cannot cross the mesh/);
    expect(client.pendingAsync()).toBe(0);
  });

  it('refuses a handler that does not end in a call, at the call site', async () => {
    using client = await connect();
    const remote = client.ctn<TestDO>().remoteEcho('property');
    expect(() => client.lmz.call('TEST_DO', 'cc-property', remote, (client.ctn() as any).received))
      .toThrow(/it must end in a call, which its answer is filled into/);
  });

  it('keeps a marker-shaped answer as data, on a callAsync and on a handler alike', async () => {
    using client = await connect();
    const answer = await client.lmz.callAsync('TEST_DO', 'cc-marker',
      client.ctn<TestDO>().replyFromStoredJson(markerShapedJson('async'))) as Record<string, unknown>;
    expect(answer.payload).toBe('reply-async');
    expect(answer.__isNestedOperation).toBe(true);

    const remote = client.ctn<TestDO>().replyFromStoredJson(markerShapedJson('handler'));
    client.lmz.call('TEST_DO', 'cc-marker', remote, client.ctn<ContinuationClient>().captureReply(remote));
    await vi.waitFor(() => expect(client.received).toHaveLength(1));
    expect((client.received[0] as Record<string, unknown>).payload).toBe('reply-handler');

    expect(client.injected, 'the injected chain must not have run').toEqual([]);
  });

  it('still resolves a template\'s genuine nesting', async () => {
    using client = await connect();
    const c = client.ctn<ContinuationClient>();
    const remote = client.ctn<TestDO>().remoteEcho('nested');
    client.lmz.call('TEST_DO', 'cc-nested', remote, c.withPrefix(c.seven()).capture(remote));
    await vi.waitFor(() => expect(client.received).toHaveLength(1));
    expect(client.received[0]).toEqual({ prefix: 7, result: 'echo: nested' });
  });

  it('names who answered as callee, on every road a refusal takes', async () => {
    using client = await connect();
    const c = client.ctn<ContinuationClient>();
    // Refused at the early ack: the Gateway fills the continuation and names the node it dispatched to.
    const refused = client.ctn<TestDO>().ping();
    client.lmz.call('REJECTING_DO', 'cc-rejecter', refused, c.recordCallee(refused));
    // Refused after the ack: the node's own fire-back names it as the last hop.
    const thrown = client.ctn<TestDO>().throwError();
    client.lmz.call('TEST_DO', 'cc-thrower', thrown, c.recordCallee(thrown));
    // Never dispatched: the Gateway has no such binding, and still names the target, from this Client.
    const nowhere = client.ctn<TestDO>().ping();
    client.lmz.call('NO_SUCH_BINDING', 'cc-nowhere', nowhere, c.recordCallee(nowhere));

    await vi.waitFor(() => expect(client.callees).toHaveLength(3));
    const byName = Object.fromEntries((client.callees as Array<{ callee: { instanceName: string } }>)
      .map((x) => [x.callee.instanceName, x]));
    expect(byName['cc-rejecter'].callee).toMatchObject({ bindingName: 'REJECTING_DO', instanceName: 'cc-rejecter' });
    expect((byName['cc-rejecter'] as any).result).toBeInstanceOf(Error);
    expect(byName['cc-thrower'].callee).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'cc-thrower' });
    expect((byName['cc-thrower'] as any).result.message).toBe('Remote error for testing');
    expect(byName['cc-nowhere'].callee).toMatchObject({ bindingName: 'NO_SUCH_BINDING', instanceName: 'cc-nowhere' });
    expect((byName['cc-nowhere'] as any).result).toBeInstanceOf(Error);
    expect((byName['cc-nowhere'] as any).origin).toMatchObject({ type: 'LumenizeClient', instanceName: client.lmz.instanceName });
  });
});
