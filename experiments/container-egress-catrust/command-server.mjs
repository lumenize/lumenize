// Minimal in-container command-server on 8080 (= the container defaultPort), reachable
// only via the DO's containerFetch. One endpoint that matters: POST /exec runs a shell
// command and returns {stdout, stderr, code, durationMs}. The DO drives the egress probe
// sequence through it. (Pared down from the phase0 command-server — no vite, no streaming.)
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = 8080;

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        rej(e);
      }
    });
    req.on("error", rej);
  });
}

function runShell(cmd) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, { shell: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => (err += String(e)));
    child.on("close", (code) =>
      res({ stdout: out, stderr: err, code: code ?? -1, durationMs: Date.now() - t0 }),
    );
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && url.pathname === "/exec") {
      const { cmd } = await readBody(req);
      const result = await runShell(cmd ?? "true");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", path: url.pathname }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.stack || e) }));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[cmd] listening on :${PORT}`));
