// Starts a raw `wrangler tail`, puts each probe object into one in-flight state, kills it, then
// waits for the tail and reports which kills' events arrived.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE ?? 'https://experiment-tail-abort.transformation.workers.dev';
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tail = spawn('npx', ['wrangler', 'tail', 'experiment-tail-abort', '--format', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
let raw = '';
tail.stdout.setEncoding('utf8').on('data', (c) => { raw += c; });
for (let i = 0; !raw && i < 45; i++) { await fetch(`${BASE}/hold?name=warm-${i}&mode=idle`); await sleep(2_000); }
if (!raw) throw new Error('tail never went live');

const runs = [];
for (let round = 0; round < ROUNDS; round++) {
  for (const mode of ['idle', 'timer', 'fetch', 'rpc', 'socket']) {
    const name = `${mode}-${round}-${crypto.randomUUID().slice(0, 8)}`;
    let ws;
    if (mode === 'socket') {
      ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?name=${name}`);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    } else {
      await fetch(`${BASE}/hold?name=${name}&mode=${mode}`);
    }
    await sleep(1_000);
    const killed = await (await fetch(`${BASE}/kill?name=${name}`)).text();
    runs.push({ name, mode, killed: killed.trim() });
    ws?.close();
  }
}
await sleep(60_000);
tail.kill();
// Ignored by the root .gitignore's `*-raw-*.json`: each event carries the client's location.
writeFileSync(new URL('../tail-raw-dump.json', import.meta.url), raw);
const killing = new Set([...raw.matchAll(/\\"tag\\":\\"killing\\",\\"name\\":\\"([^\\]+)\\"/g)].map((m) => m[1]));
const byMode = {};
for (const r of runs) {
  const got = killing.has(r.name);
  (byMode[r.mode] ??= { delivered: 0, missing: 0 })[got ? 'delivered' : 'missing']++;
  console.log(`${r.mode.padEnd(6)} ${r.name} kill answered "${r.killed}" — killing line ${got ? 'DELIVERED' : 'MISSING'}`);
}
console.log(byMode);
