// Drives the probe Worker through the plan and appends one JSON line per op to
// results/<venue>-<stamp>.jsonl. Every op runs on a fresh DO name, so a fresh container.
//
//   node scripts/drive.mjs <base-url> <plan> [reps]
//     base-url  http://localhost:8799 (wrangler dev) or the deployed workers.dev URL
//     plan      start | fresh | snap | restore | tie | all
//     reps      repetitions of each measured op (default 1)
//
// `snap` writes results/handles-<venue>.json; `restore` and `tie` read it back, so a
// restore can run in a later session (snapshots live 30 days, refreshed per restore).
// node:http rather than fetch: an install under local amd64 emulation can outlast
// fetch's 300 s headers timeout.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const [base = "http://localhost:8799", plan = "all", repsArg = "1"] = process.argv.slice(2);
const reps = Number(repsArg);
const venue = base.includes("localhost") ? "local" : "deployed";
fs.mkdirSync("results", { recursive: true });
const out = `results/${venue}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const handlesFile = `results/handles-${venue}.json`;

function post(path, body) {
  const url = new URL(path, base);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: "POST", timeout: 0 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: `HTTP ${res.statusCode}: ${data.slice(0, 500)}` });
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function op(name, body, label = name) {
  const doName = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = performance.now();
  const r = await post(`/run/${name}?do=${doName}`, body);
  const line = { label, at: new Date().toISOString(), clientMs: Math.round(performance.now() - t0), params: { ...body, handle: body.handle?.id }, ...r };
  fs.appendFileSync(out, JSON.stringify(line) + "\n");
  const brief = Object.entries(line)
    .filter(([k]) => /Ms$|Code$|error|Error|mark|tree|colo|Type$/.test(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.replace(/\s+/g, " ") : v}`)
    .join("  ");
  console.log(`[${label}] ${brief}`);
  return line;
}

const times = (n, f) => Array.from({ length: n }).reduce((p) => p.then(f), Promise.resolve());

async function start() {
  await times(reps, () => op("start", { image: "trixie" }, "start-trixie"));
  await times(reps, () => op("start", { image: "plain" }, "start-plain"));
  // All @cloudflare/computer 0.3.1 sends is { enableInternet, env } — no image.
  await op("start", { image: "plain", omitImage: true }, "start-no-image");
}

async function fresh() {
  await times(reps, () => op("fresh", { image: "baked", build: true }, "fresh-baked-build"));
  await times(reps, () => op("fresh", { image: "plain", install: true, build: true }, "fresh-plain-install-build"));
}

async function snap() {
  const r = await op("snap", { image: "plain" }, "snap");
  fs.writeFileSync(handlesFile, JSON.stringify({ at: r.at, container: r.containerSnapshot, dir: r.dirSnapshot }, null, 2));
}

function handles() {
  return JSON.parse(fs.readFileSync(handlesFile, "utf8"));
}

async function restore() {
  const h = handles();
  if (h.container) await times(reps, () => op("restore", { kind: "container", handle: h.container }, "restore-container"));
  if (h.dir) await times(reps, () => op("restore", { kind: "dir", image: "plain", handle: h.dir }, "restore-dir"));
}

async function tie() {
  const h = handles();
  // A directory snapshot restored onto a DIFFERENT image (plain2 differs from plain in one layer).
  if (h.dir) await op("restore", { kind: "dir", image: "plain2", handle: h.dir }, "tie-dir-onto-plain2");
  // A container snapshot names no image at restore. Its tie is tested across a REDEPLOY:
  // run `snap`, change plain's MARK in wrangler.jsonc, deploy, then run `tie`.
  if (h.container) await op("restore", { kind: "container", handle: h.container }, "tie-container-after-redeploy");
}

const plans = { start, fresh, snap, restore, tie, all: async () => (await start(), await fresh(), await snap(), await restore()) };
if (!plans[plan]) throw new Error(`plan must be one of ${Object.keys(plans).join(", ")}`);
console.log(`→ ${out}`);
await plans[plan]();
