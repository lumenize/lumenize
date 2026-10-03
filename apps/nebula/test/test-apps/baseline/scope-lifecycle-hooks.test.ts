/**
 * The scope lifecycle hooks — the module that wipes a deleted or created scope's Durable Objects
 * through `@rawRpc()` (ADR-023).
 *
 * In-lane, since no running system makes one of several teardowns fail: the failing target is a
 * `StarTest` named `*.explode`, whose `beforeTeardown` throws before it wipes anything. The
 * end-to-end deletion, through the facade, is the `/live` `scope-teardown` scenario's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { scopeLifecycleHooks } from '../../../src/scope-lifecycle-hooks';

const PROBE = 'scope-lifecycle-hooks-probe';
const star = (name: string) => (env as any).STAR.getByName(name);
const seed = (name: string) => (runInDurableObject as any)(star(name), (_i: any, ctx: any) => {
  ctx.storage.kv.put(PROBE, 'present');
});
const probe = (name: string) => (runInDurableObject as any)(star(name), (_i: any, ctx: any) =>
  ctx.storage.kv.get(PROBE)) as Promise<string | undefined>;

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

describe('scope lifecycle hooks — teardown', () => {
  // Mutation: let the first failure end the fan-out (await each target in turn, uncaught) → the
  // targets after the exploding one keep their storage → reds.
  it('wipes every target but a failing one, and logs that one by name', async () => {
    const u = `hk${crypto.randomUUID().slice(0, 8)}`;
    const [bad, one, two] = [`${u}.app.explode`, `${u}.app.one`, `${u}.app.two`];
    for (const name of [bad, one, two]) await seed(name);

    await scopeLifecycleHooks.teardown(
      [bad, one, two].map((instanceName) => ({ instanceName, tier: 'star' as const })), 'deletion', 'op-hk',
    );

    expect(await probe(one)).toBeUndefined();
    expect(await probe(two)).toBeUndefined();
    expect(await probe(bad)).toBe('present'); // the failure is real: it wiped nothing

    const failures = sink.filter((e) => e.namespace === 'nebula.scope.teardown' && e.message === 'teardown failed');
    expect(failures.map((e) => e.data.instanceName)).toEqual([bad]);
    expect(failures[0].level).toBe('error');
    expect(failures[0].data.message).toBe('injected teardown failure (test)');

    // Each wiped target's entry stamped its identity and the operation's id, and its rejection was
    // read as the reset it ordered. Mutation: count the abort's rejection a failure → `one` and
    // `two` join the failures above → reds.
    const markers = sink.filter((e) => e.namespace === 'nebula.scope.teardown' && e.message === 'tearing down');
    expect(markers.map((e) => e.data.instanceName).sort()).toEqual([bad, one, two].sort());
    expect(markers.every((e) => e.data.operationId === 'op-hk' && e.data.cause === 'deletion'
      && e.data.binding === 'STAR')).toBe(true);
    const resets = sink.filter((e) => e.namespace === 'nebula.scope.teardown' && e.message === 'reset as ordered');
    expect(resets.map((e) => e.data.instanceName).sort()).toEqual([one, two].sort());
  });
});
