// In-container command-server. Listens on a SECOND port (9000), distinct from
// vite's 5173, and is reachable ONLY by the host DevContainer DO via
// `containerFetch(req, 9000)` — never from the public vite proxy (the trust
// boundary: DevContainer.fetch() strips `cf-container-target-port`). It is also the
// vite SUPERVISOR: it spawns vite as a child so DevStudio can start/stop/restart the
// dev server over the command channel.
//
// Endpoints (all driven by the host DO, which DevStudio reaches over mesh):
//   GET  /healthz       -> {ok:true}                       (no child spawn; cold-boot/liveness probe)
//   POST /exec          -> {stdout,stderr,code,durationMs} (buffered command — host-DO-only)
//   POST /write         -> {ok,path}                       (one confined file write)
//   POST /apply         -> {ok,written}                    (batch confined writes — applyChanges)
//   POST /vite/restart|stop|start -> {ok}                  (manage the dev server)
//   POST /read          -> {content}                       (read a confined file — test/inspection)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PORT = 9000;
const APP_DIR = "/workspace/app";
// File-write confinement boundary: pushed source lands under the vite app's src tree,
// never anywhere else in the container. This is the RECEIVER-side guard (security.md
// "receiver re-validates") — the DO-side applyChanges re-checks too (defense-in-depth).
const ROOT = APP_DIR;

// --- vite child management ------------------------------------------------------------------
let viteChild = null;
// Event-driven preview readiness (NO polling): vite prints "ready in …" / "Local:" on
// listen, exactly once per start. We watch the child's stdout for that marker, flip
// `viteReady`, and resolve any held `/vite/ready` waiters. This is vite's own listen
// event surfaced over the command channel — never a port-poll.
let viteReady = false;
let viteReadyWaiters = [];
function markViteReady() {
  if (viteReady) return;
  viteReady = true;
  const waiters = viteReadyWaiters;
  viteReadyWaiters = [];
  for (const resolve of waiters) resolve();
}
function startVite() {
  if (viteChild) return;
  viteReady = false; // a fresh child re-announces "ready" on its own listen
  // vite inherits process.env (passed explicitly for clarity) — incl. PREVIEW_BASE,
  // which the DevContainer DO sets as a container env var so vite serves under the
  // per-instance `/dev-container/{scope}/` prefix (Flow 1d). Logged so the base is
  // visible in the container output when debugging the assembled preview.
  const previewBase = process.env.PREVIEW_BASE || "/";
  viteChild = spawn("npm", ["run", "dev"], { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  viteChild.stdout.on("data", (d) => {
    process.stdout.write(`[vite] ${d}`);
    if (!viteReady && /ready in |Local:\s*http/i.test(String(d))) markViteReady();
  });
  viteChild.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteChild.on("exit", (code, signal) => {
    console.log(`[command-server] vite exited code=${code} signal=${signal}`);
    viteChild = null;
    viteReady = false;
  });
  console.log(`[command-server] vite started pid=${viteChild.pid} PREVIEW_BASE=${previewBase}`);
}
function stopVite() {
  viteReady = false;
  return new Promise((res) => {
    if (!viteChild) return res();
    const child = viteChild;
    child.once("exit", () => res());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
  });
}
/** Resolve when vite is serving: immediate if already ready, else HELD until the
 *  stdout ready event (one request resolved by an event — no polling), bounded by a
 *  safety timeout so a never-ready vite can't hang the caller forever. */
function awaitViteReady(timeoutMs = 30000) {
  if (viteReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    viteReadyWaiters.push(() => finish(true));
    setTimeout(() => finish(false), timeoutMs);
  });
}

// --- helpers --------------------------------------------------------------------------------
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { res(raw ? JSON.parse(raw) : {}); } catch (e) { rej(e); }
    });
    req.on("error", rej);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function runBuffered({ cmd, args = [], shell = false, cwd = APP_DIR }) {
  return new Promise((res) => {
    const t0 = process.hrtime.bigint();
    const child = shell ? spawn(cmd, { cwd, shell: true }) : spawn(cmd, args, { cwd });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const done = (code) =>
      res({ stdout: out, stderr: err, code: code ?? -1, durationMs: Number(process.hrtime.bigint() - t0) / 1e6 });
    child.on("error", (e) => { err += String(e); done(-1); });
    child.on("close", done);
  });
}

// Path-traversal guard (the RECEIVER side, where the bytes land): reject any
// absolute path or `..` segment, then resolve + re-check the boundary as a
// belt-and-suspenders. On reject we throw BEFORE writeFile — nothing is written.
function resolveConfined(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error(`invalid path: ${path}`);
  if (path.startsWith("/")) throw new Error(`absolute path rejected: ${path}`);
  if (path.split(/[/\\]/).includes("..")) throw new Error(`'..' segment rejected: ${path}`);
  const abs = resolve(ROOT, path);
  if (abs !== ROOT && !abs.startsWith(ROOT + "/")) throw new Error(`path escapes ${ROOT}: ${path}`);
  return abs;
}
async function writeConfined({ path, content }) {
  const abs = resolveConfined(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content ?? "", "utf8");
  return { ok: true, path: abs };
}
async function applyConfined({ files }) {
  if (!Array.isArray(files)) throw new Error("apply requires { files: [{path, content}] }");
  // Validate every path FIRST so a bad path in the batch writes nothing at all.
  const resolved = files.map((f) => ({ abs: resolveConfined(f.path), content: f.content ?? "" }));
  for (const f of resolved) { await mkdir(dirname(f.abs), { recursive: true }); await writeFile(f.abs, f.content, "utf8"); }
  return { ok: true, written: resolved.length };
}
async function readConfined({ path }) {
  const abs = resolveConfined(path);
  return { content: await readFile(abs, "utf8") };
}

// --- server ---------------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/vite/ready") return json(res, 200, { ok: true, ready: await awaitViteReady() });

    if (req.method === "POST" && url.pathname === "/exec") return json(res, 200, await runBuffered(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/write") return json(res, 200, await writeConfined(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/apply") return json(res, 200, await applyConfined(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/read") return json(res, 200, await readConfined(await readBody(req)));

    if (req.method === "POST" && url.pathname === "/vite/restart") { await stopVite(); startVite(); return json(res, 200, { ok: true, action: "restart" }); }
    if (req.method === "POST" && url.pathname === "/vite/stop") { await stopVite(); return json(res, 200, { ok: true, action: "stop" }); }
    if (req.method === "POST" && url.pathname === "/vite/start") { startVite(); return json(res, 200, { ok: true, action: "start" }); }

    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (e) {
    return json(res, 500, { error: String(e?.stack || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[command-server] listening on :${PORT}`);
  startVite(); // bring up the dev server immediately so the public proxy (5173) is live too
});
