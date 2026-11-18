// How long does a real turn's generation cover between the box's warm and the build? Reads
// Galaxy's own markers from Workers Logs (read-only): `container warm fired` fires at the turn's
// first write, `cycle start` when the build begins. The gap between them is the time a slower
// container start (a cold snapshot restore, an R2 fetch) can hide in.
//
//   node scripts/warm-to-build.mjs <worker> [days]
//
// Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN from the repo's
// .dev.vars, as apps/nebula/harness/lib/workers-logs.ts does.
import fs from "node:fs";

const [worker, daysArg = "7"] = process.argv.slice(2);
if (!worker) throw new Error("usage: node scripts/warm-to-build.mjs <worker> [days]");
const vars = Object.fromEntries(
  fs.readFileSync(new URL("../../../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const account = vars.CLOUDFLARE_ACCOUNT_ID;
const token = vars.CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN;

async function query(from, to, message) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: `warm-to-build-${crypto.randomUUID()}`, view: "events", limit: 2000, timeframe: { from, to },
      parameters: { filters: [
        { key: "$metadata.service", operation: "eq", type: "string", value: worker },
        { key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker" },
        { key: "message", operation: "eq", type: "string", value: message },
      ] },
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`query answered ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 400)}`);
  return body.result?.events?.events ?? [];
}

/** Every event carrying `message` in the window, paging back a day at a time. */
async function all(message, days) {
  const out = [];
  const now = Date.now();
  for (let d = 0; d < days; d++) {
    const to = now - d * 86_400_000;
    const events = await query(to - 86_400_000, to, message);
    if (events.length === 2000) console.warn(`  ⚠ ${message}: day ${d} hit the 2000-event page`);
    out.push(...events);
  }
  return out.map((e) => ({ at: e.timestamp ?? Date.parse(e.source?.timestamp), instance: e.source?.data?.instanceName, src: e.source }));
}

const days = Number(daysArg);
const warms = await all("container warm fired", days);
const builds = await all("cycle start", days);
console.log(`${worker}: ${warms.length} warms, ${builds.length} build starts in ${days} days`);
if (process.env.SHOW_SAMPLE && warms[0]) console.log(JSON.stringify(warms[0].src, null, 1).slice(0, 800));

// Pair each warm with the first build start on the same Galaxy after it, within 15 minutes.
const gaps = [];
for (const w of warms) {
  const b = builds
    .filter((x) => x.instance === w.instance && x.at >= w.at && x.at - w.at < 15 * 60_000)
    .sort((a, c) => a.at - c.at)[0];
  if (b) gaps.push({ instance: w.instance, at: new Date(w.at).toISOString(), gapS: (b.at - w.at) / 1000 });
}
gaps.sort((a, b) => a.gapS - b.gapS);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]?.gapS;
console.log(`paired ${gaps.length}: min ${gaps[0]?.gapS}s  p10 ${q(0.1)}s  p25 ${q(0.25)}s  median ${q(0.5)}s  p75 ${q(0.75)}s  max ${gaps.at(-1)?.gapS}s`);
for (const t of [3, 5, 10, 15, 20, 30]) {
  console.log(`  under ${t}s: ${gaps.filter((g) => g.gapS < t).length}`);
}
fs.mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`../results/warm-to-build-${worker}.json`, import.meta.url), JSON.stringify(gaps, null, 1));
