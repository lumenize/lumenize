/**
 * Spike: what does wrangler's `createTestHarness()` buy us over spawning `wrangler dev` as a
 * subprocess and scraping stdout (`@lumenize/testing` `spawnWranglerDev`)?
 *
 * Stage A (default) — mechanics against a local fixture worker:
 *   Q1  boot + `fetch()` at all, and how long does `listen()` take?
 *   Q2  `getDurableObjectStorage().exec()` — read a DO's SQLite from Node
 *   Q3  `evictDurableObject(..., { webSockets: 'hibernate' })` — force a cold DO, keep storage + WS
 *   Q4  `getLogs()` — structured runtime logs instead of stdout scraping
 *   Q5  `reset()` wall-clock vs. a fresh boot
 *   Q6  per-worker `vars` / `secrets` overrides instead of `--var K:V` argv
 *
 * Stage B (`--nebula`) — the gating question for adoption:
 *   Q7  does it boot `apps/nebula/wrangler.jsonc`, DevContainer (Docker) and all?
 *
 * Timing note: all measurements are taken in Node, where the clock advances normally. The
 * `Date.now()`-is-pinned trap applies *inside* a Worker invocation, not here.
 *
 *   npx tsx spike.ts            # Stage A
 *   npx tsx spike.ts --nebula   # Stage A + B
 */
import { createTestHarness } from 'wrangler';
import { resolve } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

const results: Record<string, unknown> = {};
let failures = 0;

function ok(q: string, verdict: string, detail?: unknown) {
  results[q] = { verdict, detail };
  console.log(`✅ ${q}: ${verdict}`);
  if (detail !== undefined) console.log(`   ${JSON.stringify(detail)}`);
}
function bad(q: string, verdict: string, detail?: unknown) {
  failures++;
  results[q] = { verdict: `FAIL — ${verdict}`, detail };
  console.log(`❌ ${q}: ${verdict}`);
  if (detail !== undefined) console.log(`   ${JSON.stringify(detail)}`);
}

/** Open a WS, send one frame, resolve the parsed echo. */
function wsRoundTrip(url: string, payload: string, existing?: WebSocket): Promise<any> {
  return new Promise((res, rej) => {
    const ws = existing ?? new WebSocket(url);
    const timer = setTimeout(() => rej(new Error('ws timeout')), 10_000);
    ws.addEventListener('message', (e: MessageEvent) => {
      clearTimeout(timer);
      res({ ...JSON.parse(String(e.data)), ws });
    }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(new Error(`ws error ${e}`)); });
    if (existing && existing.readyState === WebSocket.OPEN) ws.send(payload);
    else ws.addEventListener('open', () => ws.send(payload), { once: true });
  });
}

async function stageA() {
  console.log('\n=== Stage A — mechanics against the local fixture ===\n');

  // Q6 up front: vars/secrets as objects, no argv plumbing.
  const server = createTestHarness({
    root: import.meta.dirname,
    workers: [{
      configPath: './wrangler.jsonc',
      vars: { GREETING: 'from-test-override' },
      secrets: { SPIKE_SECRET: 'shh' },
    }],
  });

  try {
    const t0 = performance.now();
    const { url } = await server.listen();
    const bootMs = Math.round(performance.now() - t0);

    const res = await server.fetch('/counter/alpha?id=a');
    if (!res.ok) { bad('Q1', `fetch returned ${res.status}`, await res.text()); return; }
    const body = await res.json() as any;
    ok('Q1', `booted in ${bootMs}ms, fetch works`, { url: url.href, bootMs, body });
    results.bootMs = bootMs;

    // ---- Q6: did the var override actually win over wrangler.jsonc's "from-config"? ----
    if (body.greeting === 'from-test-override') {
      const env = await server.getWorker().getEnv<{ GREETING: string; SPIKE_SECRET: string }>();
      ok('Q6', 'vars override config; secrets injected without touching .dev.vars', {
        greeting: body.greeting, secretVisible: env.SPIKE_SECRET === 'shh',
      });
    } else {
      bad('Q6', 'vars override did NOT take effect', body);
    }

    // ---- Q2: read the DO's SQLite from Node ----
    await server.fetch('/counter/alpha?id=a'); // count -> 2
    const worker = server.getWorker();
    try {
      const sql = await (worker as any).getDurableObjectStorage('Counter', { name: 'alpha' });
      const rows = await sql.exec('SELECT id, count FROM Counters');
      ok('Q2', 'read DO SQLite from Node', rows);
    } catch (e) {
      bad('Q2', `getDurableObjectStorage threw: ${(e as Error).message}`);
    }

    // ---- Q3: force eviction; storage survives, in-memory does not, WS survives ----
    const before = await (await server.fetch('/counter/beta?id=b')).json() as any;
    const sock = new WebSocket(`${url.href.replace(/^http/, 'ws')}counter/beta/ws`);
    const echoBefore = await wsRoundTrip('', 'ping-1', sock);

    try {
      await (worker as any).evictDurableObject('Counter', { name: 'beta', webSockets: 'hibernate' });
      const after = await (await server.fetch('/counter/beta?id=b')).json() as any;
      const incarnationChanged = before.incarnation !== after.incarnation;
      const storageSurvived = after.count === before.count + 1;
      if (incarnationChanged && storageSurvived) {
        ok('Q3', 'evict tore down the instance; SQLite survived', {
          before: before.incarnation.slice(0, 8), after: after.incarnation.slice(0, 8),
          countBefore: before.count, countAfter: after.count,
        });
      } else {
        bad('Q3', `incarnationChanged=${incarnationChanged} storageSurvived=${storageSurvived}`,
          { before, after });
      }
      // Did the hibernated socket survive the eviction and re-deliver to the new incarnation?
      try {
        const echoAfter = await wsRoundTrip('', 'ping-2', sock);
        ok('Q3-ws', echoAfter.incarnation === echoBefore.incarnation
          ? 'WS survived, but SAME incarnation reported'
          : 'WS survived the evict and re-delivered on a COLD incarnation', {
          before: echoBefore.incarnation.slice(0, 8), after: echoAfter.incarnation.slice(0, 8),
        });
      } catch (e) {
        bad('Q3-ws', `hibernated socket did not survive: ${(e as Error).message}`);
      }
    } catch (e) {
      bad('Q3', `evictDurableObject threw: ${(e as Error).message}`);
    } finally {
      try { sock.close(); } catch { /* ignore */ }
    }

    // ---- Q4: structured logs ----
    const logs = server.getLogs();
    const markers = logs.filter((l: any) => String(l.message ?? '').includes('[spike] Counter'));
    if (markers.length > 0) {
      ok('Q4', `getLogs() captured ${markers.length} DO-side marker(s) out of ${logs.length} entries`,
        { shape: Object.keys(markers[0] as object), sample: markers[0] });
    } else {
      bad('Q4', `no DO-side markers among ${logs.length} log entries`,
        logs.slice(0, 3));
    }
    server.clearLogs();
    ok('Q4-clear', `clearLogs() -> ${server.getLogs().length} entries`);

    // ---- Q5: reset() vs a fresh boot ----
    const t1 = performance.now();
    await server.reset();
    const resetMs = Math.round(performance.now() - t1);
    const afterReset = await (await server.fetch('/counter/alpha?id=a')).json() as any;
    const wiped = afterReset.count === 1;
    const greetingAfterReset = afterReset.greeting;
    ok('Q5', `reset() took ${resetMs}ms vs ${bootMs}ms boot — storage ${wiped ? 'WIPED' : 'SURVIVED'}`, {
      resetMs, bootMs, speedup: +(bootMs / Math.max(resetMs, 1)).toFixed(1),
      countAfterReset: afterReset.count,
      // reset() "restores the options used when the session started" — do our overrides survive?
      overridesSurviveReset: greetingAfterReset === 'from-test-override',
    });
    results.resetMs = resetMs;
  } finally {
    await server.close();
  }
}

async function stageB() {
  console.log('\n=== Stage B — apps/nebula (DevContainer / Docker) ===\n');
  const nebulaDir = resolve(import.meta.dirname, '../../apps/nebula');

  // The two prep steps `bootDevStack` does before spawning wrangler dev — both are properties of
  // the apps/nebula config, not of how it is launched, so they carry over to any harness.
  rmSync(resolve(nebulaDir, '.wrangler/state'), { recursive: true, force: true });
  mkdirSync(resolve(nebulaDir, '../nebula-studio-ui/dist'), { recursive: true });

  const server = createTestHarness({
    root: nebulaDir,
    workers: [{ configPath: './wrangler.jsonc', vars: { PRIMARY_JWT_KEY: 'BLUE' } }],
  });
  const t0 = performance.now();
  try {
    const { url } = await server.listen();
    const bootMs = Math.round(performance.now() - t0);
    // `/_version` is the one unauthenticated route on the Nebula entrypoint.
    const res = await server.fetch('/_version');
    const version = await res.text();
    if (!res.ok) {
      bad('Q7', `booted in ${bootMs}ms but /_version -> ${res.status}`, version.slice(0, 200));
      return;
    }
    ok('Q7', `apps/nebula booted in ${bootMs}ms; /_version -> ${res.status}`,
      { url: url.href, bootMs, version: version.slice(0, 120) });

    // Q8: does DO introspection reach the REAL app's classes, not just the fixture?
    const worker = server.getWorker();
    try {
      const ids = await (worker as any).listDurableObjectIds('NebulaAuthRegistry');
      const sql = await (worker as any).getDurableObjectStorage('NebulaAuthRegistry',
        { name: 'nebula-platform' });
      const tables = await sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
      ok('Q8', 'DO introspection works against real Nebula DO classes',
        { instancesWithStorage: ids, tables: tables.map((t: any) => t.name) });
    } catch (e) {
      bad('Q8', `introspection on a Nebula DO failed: ${(e as Error).message}`);
    }

    // Q9 — the other adoption blocker: apps/nebula declares two REMOTE bindings (`AI`, and
    // `send_email` with remote:true). `bootDevStack` boots WITHOUT `--local` precisely so the
    // wrangler OAuth session backs them. TestHarnessOptions exposes no local/remote switch, so
    // find out empirically whether they survive.
    try {
      const env = await worker.getEnv<Record<string, unknown>>();
      const shape = Object.fromEntries(Object.entries(env)
        .filter(([k]) => /^(AI|SEND_EMAIL|EMAIL|DEV_CONTAINER)/i.test(k))
        .map(([k, v]) => [k, v == null ? String(v) : typeof v]));
      let aiVerdict = 'not attempted';
      if (env.AI) {
        try {
          await (env.AI as any).run('@cf/meta/llama-3.2-1b-instruct',
            { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
          aiVerdict = 'env.AI.run() SUCCEEDED — remote binding is live';
        } catch (e) {
          aiVerdict = `env.AI.run() threw: ${(e as Error).message.slice(0, 160)}`;
        }
      }
      ok('Q9', 'remote-binding probe', { bindings: shape, aiVerdict });
    } catch (e) {
      bad('Q9', `getEnv() failed: ${(e as Error).message}`);
    }

    // Q10 — does `reset()` stay cheap on the REAL config, or does it re-do the container work?
    // This is the number that decides whether per-scenario isolation is affordable.
    const t1 = performance.now();
    await server.reset();
    const resetMs = Math.round(performance.now() - t1);
    const after = await server.fetch('/_version');
    ok('Q10', `apps/nebula reset() took ${resetMs}ms (boot was ${bootMs}ms); /_version -> ${after.status}`,
      { resetMs, bootMs, speedup: +(bootMs / Math.max(resetMs, 1)).toFixed(1) });
  } catch (e) {
    bad('Q7', `apps/nebula boot failed after ${Math.round(performance.now() - t0)}ms`,
      (e as Error).message);
  } finally {
    try { await server.close(); } catch { /* ignore */ }
  }
}

await stageA();
if (process.argv.includes('--nebula')) await stageB();

console.log(`\n=== Summary (${failures} failure(s)) ===`);
console.log(JSON.stringify(results, null, 2));
process.exit(failures > 0 ? 1 : 0);
