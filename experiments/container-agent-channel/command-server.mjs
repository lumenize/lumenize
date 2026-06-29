// In-container command-server (Q1 mechanism). Listens on a SECOND port (9000), distinct
// from vite's 5173, and is reachable ONLY by the lifecycle DO via `containerFetch(req, 9000)`
// — never from the public vite proxy (the Q5 trust boundary). It is also the vite SUPERVISOR:
// it spawns vite as a child so the agent can start/stop/restart the dev server (Q1).
//
// Endpoints (all driven by the DO, which the server-side agent reaches over mesh in prod):
//   GET  /healthz       -> {ok:true}                          (no child spawn; pure channel-latency probe, Q2)
//   POST /exec          -> {stdout,stderr,code,durationMs}    (buffered command, Q1/Q2)
//   POST /exec-stream   -> NDJSON stream of stdout/stderr/exit (Q3)
//   POST /write         -> {ok,path}                          (file write into the working tree, Q4)
//   POST /vite/restart|stop|start -> {ok}                     (manage the dev server, Q1)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PORT = 9000;
const APP_DIR = "/workspace/app";
const ROOT = "/workspace"; // file-write confinement boundary (Q5: commands/writes stay in-container)

// --- vite child management (Q1: start/restart the dev server) -------------------------------
let viteChild = null;
function startVite() {
  if (viteChild) return;
  viteChild = spawn("npm", ["run", "dev"], { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] });
  viteChild.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
  viteChild.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  viteChild.on("exit", (code, signal) => {
    console.log(`[command-server] vite exited code=${code} signal=${signal}`);
    viteChild = null;
  });
  console.log(`[command-server] vite started pid=${viteChild.pid}`);
}
function stopVite() {
  return new Promise((res) => {
    if (!viteChild) return res();
    const child = viteChild;
    child.once("exit", () => res());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
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

// Buffered exec: spawn, collect stdout/stderr, resolve with exit code + in-container duration.
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

// Streamed exec (Q3): NDJSON events written as they arrive, so the agent sees incremental output.
function runStream(res, { cmd, args = [], shell = false, cwd = APP_DIR }) {
  res.writeHead(200, { "content-type": "application/x-ndjson", "transfer-encoding": "chunked" });
  const t0 = Date.now();
  const emit = (o) => res.write(JSON.stringify({ ...o, tMs: Date.now() - t0 }) + "\n");
  const child = shell ? spawn(cmd, { cwd, shell: true }) : spawn(cmd, args, { cwd });
  child.stdout.on("data", (d) => emit({ stream: "stdout", data: d.toString() }));
  child.stderr.on("data", (d) => emit({ stream: "stderr", data: d.toString() }));
  child.on("error", (e) => emit({ stream: "stderr", data: String(e) }));
  child.on("close", (code) => { emit({ event: "exit", code: code ?? -1 }); res.end(); });
}

// Confined file write (Q4 + Q5): paths resolve under /workspace, never escape it.
async function writeConfined({ path, content }) {
  const abs = resolve(ROOT, path);
  if (abs !== ROOT && !abs.startsWith(ROOT + "/")) throw new Error(`path escapes ${ROOT}: ${path}`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content ?? "", "utf8");
  return { ok: true, path: abs };
}

// --- server ---------------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

    if (req.method === "POST" && url.pathname === "/exec") return json(res, 200, await runBuffered(await readBody(req)));
    if (req.method === "POST" && url.pathname === "/exec-stream") return runStream(res, await readBody(req));
    if (req.method === "POST" && url.pathname === "/write") return json(res, 200, await writeConfined(await readBody(req)));

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
