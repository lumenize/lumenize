// Minimal in-container command-server (8080). Stage 2 proves the cross-DO transport:
// DevContainer.pull() writes the source tree it fetched from DevStudio into the working dir.
// /write {path,content} and /read {path} are the only ops needed for that proof. (vite/HMR
// is already proven in container-local-dev-matrix / phase0 and intentionally left out here.)
import { createServer } from "node:http";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PORT = 8080;
const ROOT = "/workspace/app";

function readBody(req) {
  return new Promise((res, rej) => {
    const c = [];
    req.on("data", (x) => c.push(x));
    req.on("end", () => { try { res(c.length ? JSON.parse(Buffer.concat(c).toString("utf8")) : {}); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}
function json(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function confined(path) {
  const abs = resolve(ROOT, path.replace(/^\/+/, ""));
  if (abs !== ROOT && !abs.startsWith(ROOT + "/")) throw new Error(`path escapes ${ROOT}: ${path}`);
  return abs;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/write") {
      const { path, content } = await readBody(req);
      const abs = confined(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content ?? "", "utf8");
      return json(res, 200, { ok: true, path });
    }
    if (req.method === "POST" && url.pathname === "/read") {
      const { path } = await readBody(req);
      const content = await readFile(confined(path), "utf8");
      return json(res, 200, { content });
    }
    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (e) { return json(res, 500, { error: String(e?.stack || e) }); }
}).listen(PORT, "0.0.0.0", () => console.log(`[cmd] :${PORT}`));
