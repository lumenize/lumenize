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

  // A Galaxy's teardown can wait twenty seconds on a certificate order before it wipes, and a
  // 4410 sent before that let a Client read a chat it had been told was deleted (deployed only,
  // since no local Galaxy orders a certificate). A Star named `*.slow` waits a second the same way.
  // In-lane because the local stack has no teardown that waits. Mutation: close the sockets before
  // `beforeTeardown`, as the teardown first did → the Client hears 4410 while the probe is present.
  it('tells a Client its host is deleted only once the host\'s storage is gone', async () => {
    const name = `hk${crypto.randomUUID().slice(0, 8)}.app.slow`;
    await seed(name);
    const sub = crypto.randomUUID();
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // The Worker verified the token before routing; the node only decodes it.
    const jwt = `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc({ sub, aud: name, exp: Math.floor(Date.now() / 1000) + 900 })}.sig`;
    const res = await star(name).fetch(`https://example.com/gateway/STAR/${name}/${sub}.tab1`, {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': 'lmz.2',
        'Authorization': `Bearer ${jwt}`,
        'X-Lumenize-DO-Instance-Name-Or-Id': name,
        'X-Lumenize-DO-Binding-Name': 'STAR',
      },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e: CloseEvent) => resolve(e.code)));
    ws.accept();

    const teardown = scopeLifecycleHooks.teardown([{ instanceName: name, tier: 'star' }], 'deletion', 'op-slow');
    const code = await closed;
    // A probe that lands in the abort is refused with the reset itself; the next reaches the fresh object.
    let atClose: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try { atClose = await probe(name); break; } catch (e) {
        if ((e as Error).message !== 'scope-deleted' || attempt === 5) throw e;
      }
    }
    await teardown;
    expect(code).toBe(4410);
    expect(atClose).toBeUndefined();
  });
});
