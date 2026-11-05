#!/usr/bin/env node
// Touch three objects per arm, or list what Cloudflare reports for the objects a run touched.
//
//   node scripts/probe.mjs touch <run>   needs BASE, the deployed Worker's URL
//   node scripts/probe.mjs list <run>    needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKERS_READ_TOKEN
//
// The token is read from the environment and never printed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ARMS = { NOTHING: 'NothingDO', SCHEMA_READ: 'SchemaReadDO', KV_GET: 'KvGetDO',
  WRITE_DELETE_ALL: 'WriteThenDeleteAllDO', WRITE: 'WriteDO' };
const SCRIPT = 'experiment-do-readonly-storage';
const [mode, run] = process.argv.slice(2);
const idsFile = new URL(`../results/ids-${run}.json`, import.meta.url);

if (mode === 'touch') {
  const touched = [];
  for (const arm of Object.keys(ARMS)) {
    for (let i = 0; i < 3; i++) {
      const name = `${arm.toLowerCase()}-${run}-${i}`;
      const res = await fetch(`${process.env.BASE}/touch?arm=${arm}&name=${name}`);
      if (!res.ok) throw new Error(`${arm} ${name}: ${res.status} ${await res.text()}`);
      touched.push(await res.json());
    }
  }
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(idsFile, JSON.stringify(touched, null, 2));
  for (const t of touched) console.log(t.arm, t.name, t.did);
} else if (mode === 'list') {
  const touched = JSON.parse(readFileSync(idsFile, 'utf8'));
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_WORKERS_READ_TOKEN}` };
  const api = (path) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { headers })
    .then(async (r) => {
      const body = await r.json();
      if (!body.success) throw new Error(`${path}: ${r.status} ${JSON.stringify(body.errors)}`);
      return body;
    });
  const namespaces = (await api('/workers/durable_objects/namespaces?per_page=1000')).result
    .filter((n) => n.script === SCRIPT);
  const report = {};
  for (const [arm, cls] of Object.entries(ARMS)) {
    const ns = namespaces.find((n) => n.class === cls);
    if (!ns) { report[arm] = 'namespace not listed'; continue; }
    const listed = new Map();
    let cursor;
    do {
      const page = await api(`/workers/durable_objects/namespaces/${ns.id}/objects?limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      for (const o of page.result) listed.set(o.id, o.hasStoredData);
      cursor = page.result_info?.cursor || undefined;
    } while (cursor);
    report[arm] = {
      namespaceObjects: listed.size,
      touched: touched.filter((t) => t.arm === arm).map((t) =>
        ({ name: t.name, listed: listed.has(t.id), hasStoredData: listed.get(t.id) ?? null })),
    };
  }
  const at = new Date().toISOString();
  console.log(JSON.stringify({ at, run, report }, null, 2));
  writeFileSync(new URL(`../results/list-${run}-${at.replace(/[:.]/g, '-')}.json`, import.meta.url),
    JSON.stringify({ at, run, report }, null, 2));
} else {
  console.error('usage: probe.mjs touch|list <run>');
  process.exit(1);
}
