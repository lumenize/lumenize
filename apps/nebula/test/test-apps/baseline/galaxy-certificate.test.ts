/**
 * A Galaxy's certificate pack, executed — the wake, the alarm and teardown's steps against a fake
 * certificate-packs API (`certificateFakes` in `./index`).
 *
 * In-lane, since only an `https` deployment orders and the local stack's origin is `http`; the
 * fake's `https` stands in for one. The decisions themselves are `test/certificate.test.ts`'s; this
 * holds the Galaxy to them, including the timing a teardown has to get right. Ordering against
 * Cloudflare is a deployed criterion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { deploymentOrigin, hostOrigin } from '@lumenize/nebula-auth/claims';
import { rawRpcStub } from '@lumenize/mesh/raw-rpc';
import { scopeLifecycleHooks } from '../../../src/scope-lifecycle-hooks';
import { packHosts, type CertificateResult } from '../../../src/certificate';
import { Browser } from '@lumenize/testing';
import { certificateFakes, NebulaClientTest, type FakeCertificates } from './index';
import { universeAdminClient, uniqueStar, universeOf } from '../../test-helpers';

const PROBE = 'galaxy-certificate-probe';
const galaxy = (name: string) => (env as any).GALAXY.getByName(name);
const inGalaxy = <T>(name: string, fn: (inst: any, ctx: any) => T) => (runInDurableObject as any)(galaxy(name), fn) as Promise<T>;
const hostOf = (scope: string) => new URL(hostOrigin({ kind: 'scope', scope }, deploymentOrigin(env as any))).hostname;
const apex = () => new URL(deploymentOrigin(env as any)).hostname;
const tearDown = (name: string) => scopeLifecycleHooks.teardown([{ instanceName: name, tier: 'galaxy' }], 'deletion', 'op-cert');

/** A fresh galaxy with a fake API, its identity stamped by a first wake, and a probe in storage. */
async function setUp(fake: Partial<FakeCertificates> = {}): Promise<{ name: string; host: string; fake: FakeCertificates }> {
  const name = `cert${crypto.randomUUID().slice(0, 8)}.crm`;
  const full: FakeCertificates = { https: true, calls: [], packs: [], ...fake };
  certificateFakes.set(name, { ...full, https: false });
  // A first wake through the raw-RPC entry stamps the Galaxy's name, as production's first touch
  // does; the fake reads as `http` meanwhile, so it orders nothing.
  await rawRpcStub('GALAXY', name).orderCertificate('op-stamp');
  certificateFakes.set(name, full);
  await inGalaxy(name, (_i, ctx) => { ctx.storage.kv.put(PROBE, 'present'); });
  return { name, host: hostOf(name), fake: full };
}
const probe = (name: string) => inGalaxy(name, (_i, ctx) => ctx.storage.kv.get(PROBE)) as Promise<string | undefined>;

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

describe('a galaxy teardown deletes its pack, then wipes', () => {
  it("lists packs by host and deletes only its galaxy's, by host or wildcard", async () => {
    const { name, host, fake } = await setUp();
    fake.packs = [
      { id: 'own', hosts: packHosts(apex(), host), status: 'active' },
      { id: 'wild', hosts: [apex(), `*.${host}`], status: 'active' },
      { id: 'neighbour', hosts: packHosts(apex(), `x${host}`), status: 'active' },
      { id: 'apex', hosts: [apex()], status: 'active' },
    ];
    await tearDown(name);
    expect(fake.calls).toEqual(['list', 'delete:own', 'delete:wild']);
    expect(await probe(name)).toBeUndefined();
  });

  it('awaits an order in flight before listing, so the pack that order made is deleted', async () => {
    const { name, host, fake } = await setUp();
    fake.order = () => new Promise((resolve) => setTimeout(() => {
      fake.packs.push({ id: 'late', hosts: packHosts(apex(), host), status: 'initializing' });
      resolve({ ok: true, packId: 'late', status: 'initializing' });
    }, 300));
    // Start an order from the alarm, not awaited, then tear down while it is in flight.
    await inGalaxy(name, (inst: any, ctx: any) => {
      ctx.storage.kv.put('galaxy:certificate', { wanted: true });
      void inst.certificateAlarm();
    });
    await tearDown(name);
    // The order returned before the list ran, and its pack, never stored, was found by host.
    expect(fake.calls).toEqual(['order', 'order-returned', 'list', 'delete:late']);
  });

  it('a wake and an alarm arriving mid-teardown order nothing', async () => {
    const { name, fake } = await setUp({ listDelayMs: 300 });
    const done = tearDown(name);
    await new Promise((r) => setTimeout(r, 50)); // the teardown is now inside its list
    await inGalaxy(name, async (inst: any) => {
      await inst.orderCertificate('op-mid');
      await inst.certificateAlarm();
    }).catch(() => { /* the teardown's abort may cut this call off; what it ordered is what counts */ });
    await done;
    expect(fake.calls).not.toContain('order');
  });

  it('an http deployment calls no API: its teardown is the wipe alone', async () => {
    const { name, fake } = await setUp({ https: false });
    await tearDown(name);
    expect(fake.calls).toEqual([]);
    expect(await probe(name)).toBeUndefined();
  });

  it('a failed delete still wipes, and is logged naming the pack and the host', async () => {
    const { name, host, fake } = await setUp({ failDelete: true });
    fake.packs = [{ id: 'own', hosts: packHosts(apex(), host), status: 'active' }];
    await tearDown(name);
    expect(await probe(name)).toBeUndefined();
    const failed = sink.find((e) => e.namespace === 'nebula.Galaxy.certificate' && e.message === 'certificate pack delete failed');
    expect(failed?.level).toBe('error');
    expect(failed?.data).toMatchObject({ packId: 'own', host });
  });

  it('an order that outlives the wait is logged naming the host, and the teardown goes on', async () => {
    const { name, host, fake } = await setUp({ orderWaitMs: 50 });
    fake.order = () => new Promise(() => { /* never answers */ });
    await inGalaxy(name, (inst: any, ctx: any) => {
      ctx.storage.kv.put('galaxy:certificate', { wanted: true });
      void inst.certificateAlarm();
    });
    await tearDown(name);
    const outlived = sink.find((e) => e.namespace === 'nebula.Galaxy.certificate' && e.message.startsWith('an order outlived'));
    expect(outlived?.data).toEqual({ host });
    expect(await probe(name)).toBeUndefined();
  });
});

/** The Galaxy's certificate alarm, if armed. */
const certificateAlarmOf = (name: string) =>
  inGalaxy(name, (inst: any) => inst.svc.alarms.getSchedule('galaxy-certificate')) as Promise<{ time: number } | undefined>;
/** Fire the Galaxy's next alarm through mesh's own trigger, the path production's `alarm()` takes. */
const fireNextAlarm = (name: string) => inGalaxy(name, (inst: any) => inst.svc.alarms.triggerAlarms(1));
/**
 * Wait for the runtime to deliver the alarm a wake armed, whose delay is zero, until the stored state
 * shows `done`. Every later re-arm is ten seconds out at least, so a test steps those by hand.
 */
const delivered = (name: string, done: (state: any) => boolean) => vi.waitFor(async () => {
  expect(done(await inGalaxy(name, (_i, ctx) => ctx.storage.kv.get('galaxy:certificate')))).toBe(true);
}, { timeout: 15_000, interval: 100 });

describe('the alarm is the one caller of the API', () => {
  it('two wakes arm one alarm and call nothing; the alarm then orders once', async () => {
    const { name, fake } = await setUp();
    // Read inside the wakes' own invocation, before the runtime can deliver the alarm they armed.
    const atTheWakes = await inGalaxy(name, async (inst: any) => {
      await inst.orderCertificate('op-a');
      await inst.orderCertificate('op-b');
      return { calls: [...fake.calls], armed: inst.svc.alarms.getSchedule('galaxy-certificate') !== undefined };
    });
    expect(atTheWakes).toEqual({ calls: [], armed: true });
    await delivered(name, (s) => s?.packId !== undefined);
    expect(fake.calls).toEqual(['order', 'order-returned']);
  }, 20_000);

  it('a pending pack re-arms the alarm and is polled, and an active one stops it', async () => {
    const answers = ['pending_validation', 'active'];
    const { name, fake } = await setUp({ get: async (packId) => ({ ok: true, packId, status: answers.shift()! }) });
    await inGalaxy(name, async (inst: any) => { await inst.orderCertificate('op-a'); });
    await delivered(name, (s) => s?.packId !== undefined); // orders: pending
    expect(await certificateAlarmOf(name)).toBeDefined();
    await fireNextAlarm(name); // polls: still pending
    expect(await certificateAlarmOf(name)).toBeDefined();
    await fireNextAlarm(name); // polls: active
    expect(await certificateAlarmOf(name)).toBeUndefined();
    expect(fake.calls).toEqual(['order', 'order-returned', 'get:p-ordered', 'get:p-ordered']);
    expect(await inGalaxy(name, (_i, ctx) => ctx.storage.kv.get('galaxy:certificate'))).toMatchObject({ status: 'active' });
  }, 20_000);

  it('a transient failure re-arms the alarm, and the retry orders', async () => {
    const results: CertificateResult[] = [{ ok: false, transient: true }, { ok: true, packId: 'p2', status: 'pending_validation' }];
    const { name, fake } = await setUp({ order: async () => results.shift()! });
    await inGalaxy(name, async (inst: any) => { await inst.orderCertificate('op-a'); });
    await delivered(name, (s) => (s?.failures ?? 0) >= 1);
    expect(await certificateAlarmOf(name)).toBeDefined();
    await fireNextAlarm(name);
    expect(fake.calls).toEqual(['order', 'order-returned', 'order', 'order-returned']);
  }, 20_000);
});

describe('a wake a deletion overtakes is torn down again', () => {
  // In-lane, since no running system can time a deletion into the gap between the Registry's answer
  // and the wake: the fake's `onWake` deletes the galaxy's `Scopes` row as the wake arrives. Drives
  // the facade, the caller nebula-auth's own lane cannot reach.
  const registry = () => (env as any).AUTH_REGISTRY.getByName('registry');
  const deleteRow = (scope: string) => (runInDurableObject as any)(registry(), (_i: any, c: any) => {
    c.storage.sql.exec('DELETE FROM Scopes WHERE universeGalaxyStarId = ?', scope);
  });
  const reapsOf = (galaxy: string) => sink.filter((e) => e.namespace === 'nebula.scope.teardown'
    && e.data.cause === 'deletion' && e.data.instanceName === galaxy);

  async function createThroughTheFacade(onWake?: (galaxy: string) => Promise<void>): Promise<{ galaxy: string; op: string }> {
    const star = uniqueStar();
    const universe = universeOf(star);
    const { client } = await universeAdminClient(NebulaClientTest, new Browser(), star, universe, `owner-${crypto.randomUUID().slice(0, 8)}@example.com`);
    const galaxy = `${universe}.web`;
    certificateFakes.set(galaxy, { https: false, calls: [], packs: [], ...(onWake ? { onWake: () => onWake(galaxy) } : {}) });
    try {
      expect(await client.scopes.createGalaxy(universe, 'web')).toEqual({ instanceName: galaxy });
    } finally {
      client.disconnect();
    }
    const created = sink.find((e) => e.namespace === 'nebula-auth.facade.createGalaxy' && e.message === 'created'
      && e.data.target === galaxy);
    return { galaxy, op: created!.data.operationId };
  }

  it("a facade create re-reads the galaxy it woke, and tears it down when the row is gone", async () => {
    const { galaxy, op } = await createThroughTheFacade(deleteRow);
    const woke = sink.find((e) => e.namespace === 'nebula.Galaxy.orderCertificate' && e.data.instanceName === galaxy);
    expect(woke?.data.operationId).toBe(op);
    await vi.waitFor(() => expect(reapsOf(galaxy).map((e) => e.data.operationId)).toContain(op));
  });

  it('with the row left standing, the create tears nothing down after its wake', async () => {
    // The positive control: the same create, nothing deleted in the gap.
    const { galaxy } = await createThroughTheFacade();
    expect(sink.some((e) => e.namespace === 'nebula.Galaxy.orderCertificate' && e.data.instanceName === galaxy)).toBe(true);
    expect(reapsOf(galaxy)).toEqual([]);
  });
});

describe('the wake', () => {
  it('records the wanted pack and arms one alarm; an http origin records nothing', async () => {
    const { name } = await setUp();
    await inGalaxy(name, async (inst: any) => { await inst.orderCertificate('op-a'); await inst.orderCertificate('op-b'); });
    const state = await inGalaxy(name, (_i, ctx) => ctx.storage.kv.get('galaxy:certificate'));
    expect(state).toMatchObject({ wanted: true });
    const plain = await setUp({ https: false });
    await inGalaxy(plain.name, async (inst: any) => { await inst.orderCertificate('op-c'); });
    expect(await inGalaxy(plain.name, (_i, ctx) => ctx.storage.kv.get('galaxy:certificate'))).toBeUndefined();
    const marks = sink.filter((e) => e.namespace === 'nebula.Galaxy.orderCertificate' && e.data.operationId !== 'op-stamp');
    expect(marks.map((e) => e.data.operationId)).toEqual(['op-a', 'op-b', 'op-c']);
  });
});
