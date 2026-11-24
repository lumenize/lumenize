// Drives the probe Worker and appends one JSON line per op to results/<plan>-<stamp>.jsonl.
//
//   node scripts/drive.mjs <base-url> <plan> [arg]
//     setup              one install: archives to R2, then the full and base snapshots
//     delta              restore the base snapshot, add the extras from R2, snapshot again
//     once               one round (below), no waiting
//     rounds [gaps]      a round at each gap, in minutes from the start (default
//                        0,5,10,15,20,30,45,60,90). Tests whether a host keeps a snapshot.
//     split              the R2 arms with fetch and extract timed apart
//     fusesetup | fuse   the R2 FUSE arm: copy the tree in through s3fs, then build on it
//
// A round restores each snapshot from a REUSED Durable Object name first (one Galaxy's repeat
// builds), then from a fresh one (another Galaxy), then runs both R2 arms and the baked
// control. Handles and keys persist in results/handles.json; snapshots live 30 days.
// node:http rather than fetch: no 300 s headers timeout on a long op.
import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const [base, plan = "once", arg] = process.argv.slice(2);
if (!base) throw new Error("usage: node scripts/drive.mjs <base-url> <plan> [arg]");
fs.mkdirSync("results", { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = `results/${plan}-${runId}.jsonl`;
const handlesFile = "results/handles.json";

function post(path, body) {
  const url = new URL(path, base);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: "POST", timeout: 0 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data.trim()));
        } catch {
          resolve({ error: `HTTP ${res.statusCode}: ${data.trim().slice(0, 500)}` });
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function op(name, body, label, doName, extra = {}) {
  const t0 = performance.now();
  // A reset connection (seen twice from this laptop) loses this op's answer, not the run.
  const r = await post(`/run/${name}?do=${doName}`, body).catch((e) => ({ error: `client: ${e.code ?? e}` }));
  const line = { label, ...extra, at: new Date().toISOString(), clientMs: Math.round(performance.now() - t0), params: { ...body, handle: body.handle?.id }, ...r };
  fs.appendFileSync(out, JSON.stringify(line) + "\n");
  const brief = Object.entries(line)
    .filter(([k]) => /Ms$|Code$|error|mark|tree|colo|gapMin|upload|files|Size$/.test(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.replace(/\s+/g, " ") : typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("  ");
  console.log(`[${label}] ${brief}`);
  return line;
}

/** A long op: start it, then poll its result every 15 s, so no one connection has to outlive it. */
async function opAsync(name, body, label, doName, extra = {}) {
  const t0 = performance.now();
  const s = await post(`/start/${name}?do=${doName}`, body);
  if (!s.started) throw new Error(`start refused: ${JSON.stringify(s)}`);
  let r;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 15_000));
    r = await new Promise((resolve, reject) => {
      const url = new URL(`/result?do=${doName}`, base);
      (url.protocol === "https:" ? https : http).get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      }).on("error", reject);
    }).catch((e) => ({ status: "poll-failed", error: String(e) }));
    if (r.status === "done") break;
    process.stdout.write(".");
  }
  const line = { label, ...extra, at: new Date().toISOString(), clientMs: Math.round(performance.now() - t0), params: body, ...r };
  fs.appendFileSync(out, JSON.stringify(line) + "\n");
  console.log(`\n[${label}] ${JSON.stringify(Object.fromEntries(Object.entries(line).filter(([k]) => /Ms$|error|populate|files|Tail$/.test(k))))}`);
  return line;
}

const fresh = (label) => `${label}-${crypto.randomUUID().slice(0, 8)}`;
const readHandles = () => JSON.parse(fs.readFileSync(handlesFile, "utf8"));
const writeHandles = (h) => fs.writeFileSync(handlesFile, JSON.stringify(h, null, 2));

async function setup() {
  const r = await op("setup", {}, "setup", fresh("setup"));
  if (r.error) throw new Error(r.error);
  writeHandles({ at: r.at, keys: r.keys, full: r.full, base: r.base });
}

async function delta() {
  const h = readHandles();
  const r = await op("delta", { handle: h.base, key: h.keys.extras }, "delta", fresh("delta"));
  if (r.error) throw new Error(r.error);
  writeHandles({ ...h, delta: r.delta });
}

async function round(gapMin, sameIds) {
  const h = readHandles();
  const x = { gapMin };
  await op("restore", { handle: h.full }, "restore-full-same", sameIds.full, x);
  if (h.delta) await op("restore", { handle: h.delta }, "restore-delta-same", sameIds.delta, x);
  await op("restore", { handle: h.full }, "restore-full-fresh", fresh("rf"), x);
  if (h.delta) await op("restore", { handle: h.delta }, "restore-delta-fresh", fresh("rd"), x);
  await op("r2full", { key: h.keys.full }, "r2-full", fresh("r2f"), x);
  await op("r2extras", { key: h.keys.extras }, "r2-extras-on-base", fresh("r2e"), x);
  await op("baked", {}, "baked", fresh("baked"), x);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function rounds() {
  // `rounds <gaps> [<runId> <startIso>]` resumes a run: the same Galaxies, gaps from its start.
  const [, , , gapsArg, resumeId, startIso] = process.argv.slice(1);
  const gaps = (gapsArg ?? "0,5,10,15,20,30,45,60,90").split(",").map(Number);
  // One Galaxy per run for the "same" arms, so a host's cache is all that can carry over.
  const id = resumeId ?? runId;
  const sameIds = { full: `galaxy-full-${id}`, delta: `galaxy-delta-${id}` };
  const t0 = startIso ? Date.parse(startIso) : Date.now();
  for (const g of gaps) {
    const wait = t0 + g * 60_000 - Date.now();
    if (wait > 0) {
      console.log(`… sleeping ${Math.round(wait / 1000)} s until the ${g}-minute round`);
      await sleep(wait);
    }
    await round(g, sameIds);
  }
}

async function split() {
  const h = readHandles();
  await op("r2full", { key: h.keys.full, stream: false }, "r2-full-split", fresh("r2fs"));
  await op("r2extras", { key: h.keys.extras, stream: false }, "r2-extras-split", fresh("r2es"));
}

/** Why is a build on a freshly unpacked whole tree slow? Same op, with a sync and a second build. */
async function diag() {
  const h = readHandles();
  await op("r2full", { key: h.keys.full, diag: true }, "r2-full-diag", fresh("r2fd"));
  await op("r2extras", { key: h.keys.extras, diag: true }, "r2-extras-diag", fresh("r2ed"));
  await op("baked", {}, "baked-control", fresh("bakedc"));
}

// Times each native binding's FIRST load on its own, then shows what the unpacked tree carries
// that the baked one does not. Runs before the build, so the build that follows is a second load.
const PROBE = [
  "chown 0:0 / 2>/dev/null",
  `t() { s=$(date +%s%N); node --input-type=module -e "await import('$1')" >/dev/null 2>&1; echo "$(( ($(date +%s%N)-s)/1000000 ))ms $1 exit=$?"; }`,
  "t @swc/core; t rolldown; t @tailwindcss/oxide; t lightningcss; t vite; t @vitejs/plugin-vue",
  "echo '-- dot entries:'; du -sm node_modules/.[!.]* 2>/dev/null | sort -n | tail -4",
  "echo '-- ~/.cache:'; du -sm ~/.cache 2>/dev/null; ls ~/.cache 2>/dev/null | head",
].join("; ");

async function probe() {
  const h = readHandles();
  await op("r2full", { key: h.keys.full, cmd: PROBE }, "r2-full-probe", fresh("r2fp"));
  await op("baked", { cmd: PROBE }, "baked-probe", fresh("bakedp"));
}

const plans = {
  probe,
  diag,
  setup,
  delta,
  once: () => round(0, { full: fresh("galaxy-full"), delta: fresh("galaxy-delta") }),
  rounds,
  split,
  fusesetup: () => opAsync("fusesetup", {}, "fuse-setup", fresh("fusesetup")),
  fusepopulate: () => opAsync("fusepopulate", { key: readHandles().keys.full }, "fuse-populate", fresh("fusepop")),
  fuse: () => opAsync("fuse", { timeoutS: Number(arg ?? 900) }, "fuse-build", fresh("fuse")),
  // What the build's timeout is made of: a stat walk of every entry, then a read of every byte.
  fusewalk: () => opAsync("fuse", { cmd: [
    "S=$(date +%s%N); n=$(timeout 600 find node_modules | wc -l); echo \"walk: $n entries in $(( ($(date +%s%N)-S)/1000000 ))ms\"",
    "S=$(date +%s%N); timeout 600 tar -cf - node_modules | wc -c | xargs echo read bytes:; echo \"read: $(( ($(date +%s%N)-S)/1000000 ))ms\"",
  ].join("; ") }, "fuse-walk", fresh("fusewalk")),
};
if (!plans[plan]) throw new Error(`plan must be one of ${Object.keys(plans).join(", ")}`);
console.log(`→ ${out}`);
await plans[plan]();
