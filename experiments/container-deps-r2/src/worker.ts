// SPIKE — where should a Galaxy's node_modules come from: the image, a container snapshot,
// an R2 archive, or an R2 FUSE mount?
//
// One op per request, each on the Durable Object name the driver picks (a fresh name gets a
// fresh container with fresh placement; a reused name models one Galaxy's repeat builds).
// Every op starts a container, measures, and destroys it, the ephemeral shape Nebula's
// Galaxy uses per build.
//
// The container reaches R2 only through this Worker's own entrypoints, registered with
// interceptOutboundHttp before each start(): R2Gateway for whole-object archives, S3Shim for
// s3fs. So no credentials enter the container, and the build arms run with internet off.
//
// Timing is DO-side Date.now() around AWAITED I/O, which advances the clock (the
// cf-clock-traps memory). The command server also times each command in-container.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// The container's command server, passed as the entrypoint at start(). bash, not sh, for
// `set -o pipefail` in the archive pipelines. `node -e` is CJS.
const SERVER = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
let mark = "none";
try { mark = fs.readFileSync("/image-mark", "utf8").trim(); } catch {}
http.createServer((req, res) => {
  if (req.url === "/health") { res.end(JSON.stringify({ ok: true, mark })); return; }
  if (req.url === "/exec" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { cmd, cwd } = JSON.parse(body);
      const t0 = Date.now();
      const p = spawn("bash", ["-c", cmd], { cwd: cwd || "/", env: process.env });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out = (out + d).slice(-4000)));
      p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
      p.on("close", (code) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code, ms: Date.now() - t0, out, err }));
      });
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8080, "0.0.0.0");
`;

const PORT = 8080;
const INSTANCE = "standard-2"; // what apps/nebula runs (BUILD_BOX_INSTANCE in its galaxy.ts)
const READY_DEADLINE_MS = 180_000;
// Deployed, `/` is owned by uid 2346 and @swc/core >= 1.16.12 refuses to load
// (experiments/container-snapshot-deps finding 7); handing `/` back to root fixes it.
// npm's update notifier is off because with internet off a DNS lookup hangs 56 s before it
// fails: on an image with no ~/.npm/_update-notifier-last-checked, the first `npx` waited on
// one and added ~25 s to the build (RESULTS.md finding on the slow whole-tree build).
const BUILD = "chown 0:0 / 2>/dev/null; npm_config_update_notifier=false NO_UPDATE_NOTIFIER=1 npx vite build";
const DEPS_HOST = "deps.r2";
const S3_HOST = "s3.r2";
// The app's extras: what the `base` image leaves out and the extras archive carries.
const EXTRAS = "node_modules/echarts node_modules/zrender node_modules/three node_modules/date-fns node_modules/lodash-es";
// Under the 100 MiB default limit on an outbound request body.
const PART = "64m";
// Every s3fs object lives under this R2 prefix, apart from the archives.
const S3_ROOT = "s3/";

/** Upload a file as numbered parts plus a `.parts` count, then print its size. */
const UPLOAD_FN = `up() { f=$1; k=$2; rm -f /tmp/part.*; split -b ${PART} -d -a 2 "$f" /tmp/part.; n=0; for p in /tmp/part.*; do curl -sS --fail -T "$p" "http://${DEPS_HOST}/$k.part$n" >/dev/null || return 1; n=$((n+1)); done; printf "%s" "$n" > /tmp/n; curl -sS --fail -T /tmp/n "http://${DEPS_HOST}/$k.parts" >/dev/null || return 1; rm -f /tmp/part.* /tmp/n; echo "parts=$n bytes=$(stat -c %s "$f")"; }`;
/** Write an archive's parts, in order, to stdout. */
const FETCH_FN = `fetchparts() { n=$(curl -sS --fail "http://${DEPS_HOST}/$1.parts") || return 1; for i in $(seq 0 $((n-1))); do curl -sS --fail "http://${DEPS_HOST}/$1.part$i" || return 1; done; }`;

type ImageName = "plain" | "baked" | "base";
type ExecResult = { code: number | null; ms: number; out: string; err: string };
type Result = Record<string, unknown>;

interface Params {
  image?: ImageName;
  handle?: ContainerSnapshot;
  /** Archive key, without the `.parts` / `.partN` suffix. */
  key?: string;
  /** true: curl | zstd | tar in one pipeline, Nebula's shape. false: fetch, then extract. */
  stream?: boolean;
  /** `fuse` only: cap on the build, in seconds. */
  timeoutS?: number;
  /**
   * R2 ops only: after unpacking, report dirty pages and time a `sync` before the build, then
   * build a second time. Splits disk writeback from a first-build cost.
   */
  diag?: boolean;
  /** R2 ops and `baked`: a command to run before the build, its output kept. */
  cmd?: string;
}

/**
 * Puts every entry of an unpacked /app/node_modules into R2 through S3Shim, 64 at a time, with
 * the metadata s3fs reads back: x-amz-meta-mode (st_mode, so the type bits and the exec bit),
 * uid, gid, mtime. A directory is a `key/` object; a symlink's body is its target. s3fs's own
 * `cp` into the mount made several round trips per file, too slow to finish.
 */
const POPULATE = `
import fs from "node:fs"; import path from "node:path";
const root = "/app/node_modules", items = [];
const walk = (d, rel) => { for (const e of fs.readdirSync(d)) { const p = path.join(d, e), r = rel + "/" + e, st = fs.lstatSync(p); items.push({ p, r, st }); if (st.isDirectory()) walk(p, r); } };
walk(root, "node_modules");
const dirMode = fs.statSync(root).mode;
items.unshift({ r: "node_modules", st: { isDirectory: () => true, isSymbolicLink: () => false, mode: dirMode, mtimeMs: Date.now() } });
let i = 0, ok = 0, bad = 0, bytes = 0;
const put = async (it) => {
  const dir = it.st.isDirectory(), link = !dir && it.st.isSymbolicLink();
  const key = "tree/" + it.r + (dir ? "/" : "");
  const headers = { "x-amz-meta-mode": String(it.st.mode), "x-amz-meta-uid": "0", "x-amz-meta-gid": "0", "x-amz-meta-mtime": String(Math.floor(it.st.mtimeMs / 1000)) };
  let body = "";
  if (dir) headers["content-type"] = "application/x-directory";
  else if (link) body = fs.readlinkSync(it.p);
  else body = fs.readFileSync(it.p);
  bytes += body.length;
  const res = await fetch("http://${"s3.r2"}/b/" + key.split("/").map(encodeURIComponent).join("/"), { method: "PUT", headers, body });
  if (res.ok) ok++; else bad++;
};
const worker = async () => { while (i < items.length) { const it = items[i++]; try { await put(it); } catch { bad++; } } };
await Promise.all(Array.from({ length: 64 }, worker));
console.log(JSON.stringify({ entries: items.length, ok, bad, mb: Math.round(bytes / 1e6) }));
`;

export class Probe extends DurableObject<Env> {
  /**
   * Start an op and return at once; `result()` answers it later. The answer of a long op over
   * one HTTP request was lost when the client's connection reset nine minutes in, while the op
   * itself ran on. The driver's polls keep the object resident.
   */
  start(op: string, p: Params): { started: string } {
    const startedAt = new Date().toISOString();
    this.ctx.storage.kv.put("result", { status: "running", op, startedAt });
    this.ctx.waitUntil(this.run(op, p).then((r) => this.ctx.storage.kv.put("result", { status: "done", startedAt, ...r })));
    return { started: startedAt };
  }

  result(): Result {
    return (this.ctx.storage.kv.get("result") as Result | undefined) ?? { status: "none" };
  }

  async run(op: string, p: Params): Promise<Result> {
    const r: Result = { op, image: p.image };
    try {
      if (op === "setup") await this.#opSetup(r);
      else if (op === "delta") await this.#opDelta(p, r);
      else if (op === "baked") await this.#opBaked(p, r);
      else if (op === "restore") await this.#opRestore(p, r);
      else if (op === "r2full") await this.#opR2(p, r, "plain", "/app");
      else if (op === "r2extras") await this.#opR2(p, r, "base", "/app");
      else if (op === "fusesetup") await this.#opFuseSetup(r);
      else if (op === "fuse") await this.#opFuse(p, r);
      else if (op === "fusepopulate") await this.#opFusePopulate(p, r);
      else throw new Error(`unknown op ${op}`);
    } catch (e) {
      r.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    } finally {
      await this.#destroy();
    }
    return r;
  }

  get #c(): Container {
    if (!this.ctx.container) throw new Error("no ctx.container (not a container-bound DO?)");
    return this.ctx.container;
  }

  /**
   * Register both intercepts, start(), then poll /health. start() returns before the
   * container is ready, so readyMs is start() → first healthy probe.
   */
  async #start(r: Result, opts: { image?: ImageName; snapshot?: ContainerSnapshot; internet?: boolean }): Promise<void> {
    const t0 = Date.now();
    await this.#c.interceptOutboundHttp(DEPS_HOST, this.ctx.exports.R2Gateway);
    await this.#c.interceptOutboundHttp(S3_HOST, this.ctx.exports.S3Shim);
    r.interceptMs = Date.now() - t0;

    const base = {
      enableInternet: !!opts.internet,
      instance: INSTANCE,
      entrypoint: ["node", "-e", SERVER],
    };
    const startOpts = opts.snapshot
      ? { ...base, containerSnapshot: { id: opts.snapshot.id } }
      : { ...base, image: this.#c.images[opts.image ?? "plain"] };
    const t1 = Date.now();
    this.#c.start(startOpts as unknown as ContainerStartupOptions);
    // containers.md: attach monitor() so a crash-on-boot surfaces rather than a silent timeout.
    this.#c.monitor().catch((e: unknown) => console.log("monitor", e instanceof Error ? e.message : String(e)));
    let lastErr = "";
    while (Date.now() - t1 < READY_DEADLINE_MS) {
      try {
        const res = await this.#c.getTcpPort(PORT).fetch("http://container/health");
        if (res.ok) {
          r.readyMs = Date.now() - t1;
          r.mark = ((await res.json()) as { mark: string }).mark;
          await this.#where(r);
          return;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`not ready after ${READY_DEADLINE_MS} ms: ${lastErr}`);
  }

  /** Where the container landed: the gateway's view of the colo, and the host's CPU model. */
  async #where(r: Result): Promise<void> {
    const x = await this.#exec(`curl -sS --max-time 5 http://${DEPS_HOST}/__where; echo; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2`, "/");
    const [where, cpu] = x.out.trim().split("\n");
    try {
      r.colo = (JSON.parse(where) as { colo?: string }).colo;
    } catch {
      r.whereRaw = x.out.slice(0, 300) + x.err.slice(0, 300);
    }
    r.cpu = cpu?.trim();
  }

  async #exec(cmd: string, cwd = "/app"): Promise<ExecResult> {
    const res = await this.#c.getTcpPort(PORT).fetch("http://container/exec", {
      method: "POST",
      body: JSON.stringify({ cmd, cwd }),
    });
    return (await res.json()) as ExecResult;
  }

  /** Record an exec's time and exit, keeping a tail of output only on failure. */
  #keep(r: Result, key: string, x: ExecResult): ExecResult {
    r[`${key}Ms`] = x.ms;
    if (x.code !== 0) {
      r[`${key}Code`] = x.code;
      r[`${key}Tail`] = (x.err || x.out).slice(-1500);
      throw new Error(`${key} exited ${x.code}`);
    }
    return x;
  }

  async #probe(cmd: string, r: Result): Promise<void> {
    const x = await this.#exec(cmd);
    r.probeMs = x.ms;
    r.probe = (x.out + x.err).trim();
  }

  async #tree(r: Result): Promise<void> {
    const x = await this.#exec("echo pkgs=$(ls node_modules 2>/dev/null | wc -l) mb=$(du -sm node_modules 2>/dev/null | cut -f1)");
    r.tree = x.out.trim();
  }

  async #snapshot(r: Result, key: string, name: string): Promise<void> {
    const t0 = Date.now();
    const snap = await this.#c.snapshotContainer({ name });
    r[`${key}SnapMs`] = Date.now() - t0;
    r[key] = snap;
  }

  async #destroy(): Promise<void> {
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
    } catch {
      // already gone
    }
  }

  // ── ops ────────────────────────────────────────────────────────────────────

  /**
   * One install feeds every arm: the archives go up to R2, then the whole tree is
   * snapshotted, then the tree minus the extras (the shared base a per-Galaxy delta sits on).
   */
  async #opSetup(r: Result): Promise<void> {
    await this.#start(r, { image: "plain", internet: true });
    this.#keep(r, "install", await this.#exec("npm ci --include=dev --no-audit --no-fund"));
    this.#keep(r, "build", await this.#exec(`${BUILD} && rm -rf dist`));
    await this.#tree(r);
    const lock = await this.#exec("sha256sum package-lock.json | cut -c1-16");
    const hash = lock.out.trim();
    r.files = (await this.#exec("find node_modules | wc -l")).out.trim();

    const fullKey = `deps/full-${hash}.tar.zst`;
    const extrasKey = `deps/extras-${hash}.tar.zst`;
    this.#keep(r, "packFull", await this.#exec("tar -cf - node_modules | zstd -T0 -3 -q -o /tmp/full.tzst"));
    this.#keep(r, "packExtras", await this.#exec(`tar -cf - ${EXTRAS} | zstd -T0 -3 -q -o /tmp/extras.tzst`));
    r.uploadFull = this.#keep(r, "uploadFull", await this.#exec(`${UPLOAD_FN}; up /tmp/full.tzst ${fullKey}`)).out.trim();
    r.uploadExtras = this.#keep(r, "uploadExtras", await this.#exec(`${UPLOAD_FN}; up /tmp/extras.tzst ${extrasKey}`)).out.trim();
    r.keys = { full: fullKey, extras: extrasKey };
    await this.#exec("rm -f /tmp/*.tzst");

    await this.#snapshot(r, "full", "deps-full");
    this.#keep(r, "dropExtras", await this.#exec(`rm -rf ${EXTRAS}`));
    await this.#snapshot(r, "base", "deps-base");
  }

  /**
   * The per-Galaxy delta: restore the shared base, add the extras from R2 (no registry, so no
   * internet), prove it builds, and snapshot again. A snapshot of a snapshot.
   */
  async #opDelta(p: Params, r: Result): Promise<void> {
    if (!p.handle || !p.key) throw new Error("delta needs the base handle and the extras key");
    await this.#start(r, { snapshot: p.handle });
    this.#keep(r, "extras", await this.#exec(`set -o pipefail; ${FETCH_FN}; fetchparts ${p.key} | zstd -d -T0 -q | tar -x -C /app`));
    this.#keep(r, "build", await this.#exec(`${BUILD} && rm -rf dist`));
    await this.#tree(r);
    await this.#snapshot(r, "delta", "deps-delta");
  }

  /** Today's Nebula shape: the whole tree is in the image. */
  async #opBaked(p: Params, r: Result): Promise<void> {
    await this.#start(r, { image: "baked" });
    if (p.cmd) await this.#probe(p.cmd, r);
    this.#keep(r, "build", await this.#exec(BUILD));
    await this.#tree(r);
  }

  /** Start from a snapshot with internet off, then prove the restored tree builds. */
  async #opRestore(p: Params, r: Result): Promise<void> {
    if (!p.handle) throw new Error("restore needs a handle");
    r.snapSize = p.handle.size;
    await this.#start(r, { snapshot: p.handle });
    this.#keep(r, "build", await this.#exec(BUILD));
    await this.#tree(r);
  }

  /** A fixed image, and the tree (r2full) or the extras (r2extras) from an R2 archive. */
  async #opR2(p: Params, r: Result, image: ImageName, dest: string): Promise<void> {
    if (!p.key) throw new Error("r2 needs a key");
    await this.#start(r, { image });
    if (p.stream !== false) {
      this.#keep(r, "fetchExtract", await this.#exec(`set -o pipefail; ${FETCH_FN}; fetchparts ${p.key} | zstd -d -T0 -q | tar -x -C ${dest}`));
    } else {
      this.#keep(r, "fetch", await this.#exec(`set -o pipefail; ${FETCH_FN}; fetchparts ${p.key} > /tmp/a.tzst`));
      r.archiveBytes = Number((await this.#exec("stat -c %s /tmp/a.tzst")).out.trim());
      this.#keep(r, "extract", await this.#exec(`zstd -d -T0 -q < /tmp/a.tzst | tar -x -C ${dest} && rm /tmp/a.tzst`));
    }
    if (p.diag) {
      r.dirtyBefore = (await this.#exec("grep -E '^(Dirty|Writeback):' /proc/meminfo | tr -s ' ' | tr '\\n' ' '")).out.trim();
      this.#keep(r, "sync", await this.#exec("sync"));
      r.mounts = (await this.#exec("grep -E ' / | /app ' /proc/mounts | head -3; df -h / | tail -1")).out.trim();
    }
    if (p.cmd) await this.#probe(p.cmd, r);
    this.#keep(r, "build", await this.#exec(BUILD));
    if (p.diag) this.#keep(r, "build2", await this.#exec(`rm -rf dist && ${BUILD}`));
    await this.#tree(r);
  }

  /** Install, then copy the tree into R2 through s3fs, so s3fs writes its own metadata. */
  async #opFuseSetup(r: Result): Promise<void> {
    await this.#start(r, { image: "plain", internet: true });
    this.#keep(r, "install", await this.#exec("npm ci --include=dev --no-audit --no-fund"));
    r.files = (await this.#exec("find node_modules | wc -l")).out.trim();
    this.#keep(r, "mount", await this.#exec(`${s3fsMount("b:/tree", "/mnt/s3")}`, "/"));
    this.#keep(r, "copy", await this.#exec("mkdir -p /mnt/s3/node_modules && ls -A /app/node_modules | xargs -P 16 -I{} cp -a /app/node_modules/{} /mnt/s3/node_modules/", "/"));
    this.#keep(r, "unmount", await this.#exec("fusermount3 -u /mnt/s3 || umount /mnt/s3", "/"));
  }

  /** Unpack the whole-tree archive, then put every entry into R2 in s3fs's object shape. */
  async #opFusePopulate(p: Params, r: Result): Promise<void> {
    if (!p.key) throw new Error("fusepopulate needs the full archive's key");
    await this.#start(r, { image: "plain" });
    this.#keep(r, "fetchExtract", await this.#exec(`set -o pipefail; ${FETCH_FN}; fetchparts ${p.key} | zstd -d -T0 -q | tar -x -C /app`));
    const x = this.#keep(r, "populate", await this.#exec(`cat > /tmp/populate.mjs <<'EOF'\n${POPULATE}\nEOF\nnode /tmp/populate.mjs`));
    r.populate = x.out.trim();
  }

  /** The tree is an R2 FUSE mount at /app/node_modules; does vite build, and how fast? */
  async #opFuse(p: Params, r: Result): Promise<void> {
    await this.#start(r, { image: "plain" });
    this.#keep(r, "mount", await this.#exec(s3fsMount("b:/tree/node_modules", "/app/node_modules"), "/"));
    this.#keep(r, "ls", await this.#exec("ls node_modules | wc -l"));
    if (p.cmd) {
      await this.#probe(p.cmd, r);
      return;
    }
    this.#keep(r, "build", await this.#exec(`timeout ${p.timeoutS ?? 900} bash -c '${BUILD}'`));
  }
}

/**
 * s3fs against the S3Shim, path-style, one PUT per file (no multipart), with throwaway
 * credentials the shim never checks. It daemonizes, so wait for the mountpoint.
 */
function s3fsMount(source: string, at: string): string {
  return [
    `mkdir -p ${at}`,
    "echo 'id:secret' > /etc/passwd-s3fs && chmod 600 /etc/passwd-s3fs",
    `s3fs ${source} ${at} -o url=http://${S3_HOST} -o use_path_request_style -o nomultipart -o compat_dir -o passwd_file=/etc/passwd-s3fs -o dbglevel=warn`,
    `for i in $(seq 1 100); do mountpoint -q ${at} && exit 0; sleep 0.1; done; echo 'mount never appeared' >&2; exit 1`,
  ].join(" && ");
}

/**
 * Whole objects by key, for the archives. PUT stores the body (the container sends a
 * Content-Length, which an R2 put needs); GET streams it back. `__where` reports the colo.
 */
export class R2Gateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (key === "__where") {
      return Response.json({ colo: (request.cf as { colo?: string } | undefined)?.colo ?? null });
    }
    if (request.method === "PUT") {
      const o = await this.env.DEPS.put(key, request.body ?? "");
      return Response.json({ size: o?.size });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const o = await this.env.DEPS.get(key);
      if (!o) return new Response("not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : o.body, { headers: { "content-length": String(o.size) } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

/**
 * The slice of the S3 API s3fs uses, over the R2 binding: list (v1 and v2), HEAD, GET with
 * Range, PUT, PUT-copy and DELETE, path-style. It never checks a signature, which is what
 * S3Mount's gateway does in its place. x-amz-meta-* round-trips through customMetadata,
 * because s3fs keeps a file's mode there, and a native binary that loses its exec bit
 * cannot run.
 */
export class S3Shim extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, bucket = "b", ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const m = request.method;

    if (key === "") {
      if (url.searchParams.has("location")) {
        return xml(`<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">auto</LocationConstraint>`);
      }
      if (m === "GET" || m === "HEAD") return this.#list(bucket, url.searchParams);
      return new Response(null, { status: 200 });
    }

    const rkey = S3_ROOT + key;
    if (m === "HEAD" || m === "GET") {
      const hasRange = request.headers.has("range");
      const o = m === "HEAD"
        ? await this.env.DEPS.head(rkey)
        : await this.env.DEPS.get(rkey, hasRange ? { range: request.headers } : {});
      if (!o) return m === "HEAD" ? new Response(null, { status: 404 }) : s3Error(404, "NoSuchKey");
      const headers = objectHeaders(o);
      const body = "body" in o ? (o as R2ObjectBody).body : null;
      const range = (o as R2Object).range as { offset?: number; length?: number } | undefined;
      if (m === "GET" && hasRange && range && range.offset !== undefined) {
        const len = range.length ?? o.size - range.offset;
        headers.set("content-length", String(len));
        headers.set("content-range", `bytes ${range.offset}-${range.offset + len - 1}/${o.size}`);
        return new Response(body, { status: 206, headers });
      }
      return new Response(m === "HEAD" ? null : body, { headers });
    }
    if (m === "PUT") {
      const copySource = request.headers.get("x-amz-copy-source");
      if (copySource) {
        const srcKey = S3_ROOT + decodeURIComponent(copySource).replace(/^\/?[^/]+\//, "");
        const src = await this.env.DEPS.get(srcKey);
        if (!src) return s3Error(404, "NoSuchKey");
        const replace = (request.headers.get("x-amz-metadata-directive") ?? "COPY").toUpperCase() === "REPLACE";
        const o = await this.env.DEPS.put(rkey, src.body, {
          customMetadata: replace ? metaFrom(request.headers) : src.customMetadata,
          httpMetadata: { contentType: (replace ? request.headers.get("content-type") : src.httpMetadata?.contentType) ?? undefined },
        });
        return xml(`<CopyObjectResult><LastModified>${o!.uploaded.toISOString()}</LastModified><ETag>"${o!.etag}"</ETag></CopyObjectResult>`);
      }
      const o = await this.env.DEPS.put(rkey, request.body ?? "", {
        customMetadata: metaFrom(request.headers),
        httpMetadata: { contentType: request.headers.get("content-type") ?? undefined },
      });
      return new Response(null, { headers: { etag: `"${o!.etag}"` } });
    }
    if (m === "DELETE") {
      await this.env.DEPS.delete(rkey);
      return new Response(null, { status: 204 });
    }
    return s3Error(405, "MethodNotAllowed");
  }

  async #list(bucket: string, q: URLSearchParams): Promise<Response> {
    const v2 = q.get("list-type") === "2";
    const prefix = q.get("prefix") ?? "";
    const delimiter = q.get("delimiter") || undefined;
    const limit = Math.min(Number(q.get("max-keys") ?? 1000) || 1000, 1000);
    const token = v2 ? q.get("continuation-token") : q.get("marker");
    // A token this shim minted carries R2's cursor; any other marker is a key to start after.
    const opts: R2ListOptions = { prefix: S3_ROOT + prefix, delimiter, limit, include: ["httpMetadata", "customMetadata"] };
    if (token?.startsWith("~c~")) opts.cursor = token.slice(3);
    else if (token) opts.startAfter = S3_ROOT + token;
    else if (v2 && q.get("start-after")) opts.startAfter = S3_ROOT + q.get("start-after");
    const r = await this.env.DEPS.list(opts);
    const strip = (k: string) => esc(k.slice(S3_ROOT.length));
    const contents = r.objects
      .map((o) => `<Contents><Key>${strip(o.key)}</Key><LastModified>${o.uploaded.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
      .join("");
    const prefixes = r.delimitedPrefixes.map((p) => `<CommonPrefixes><Prefix>${strip(p)}</Prefix></CommonPrefixes>`).join("");
    const next = r.truncated ? `~c~${r.cursor}` : "";
    const paging = v2
      ? `<KeyCount>${r.objects.length + r.delimitedPrefixes.length}</KeyCount>${q.get("continuation-token") ? `<ContinuationToken>${esc(q.get("continuation-token")!)}</ContinuationToken>` : ""}${next ? `<NextContinuationToken>${esc(next)}</NextContinuationToken>` : ""}`
      : `<Marker>${esc(q.get("marker") ?? "")}</Marker>${next ? `<NextMarker>${esc(next)}</NextMarker>` : ""}`;
    return xml(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>` +
        `${paging}<MaxKeys>${limit}</MaxKeys>${delimiter ? `<Delimiter>${esc(delimiter)}</Delimiter>` : ""}` +
        `<IsTruncated>${r.truncated}</IsTruncated>${contents}${prefixes}</ListBucketResult>`,
    );
  }
}

function metaFrom(h: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.startsWith("x-amz-meta-")) meta[k.slice("x-amz-meta-".length)] = v;
  });
  return meta;
}

function objectHeaders(o: R2Object): Headers {
  const h = new Headers({
    "content-length": String(o.size),
    etag: `"${o.etag}"`,
    "last-modified": o.uploaded.toUTCString(),
    "content-type": o.httpMetadata?.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
  });
  for (const [k, v] of Object.entries(o.customMetadata ?? {})) h.set(`x-amz-meta-${k}`, v);
  return h;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xml(body: string, status = 200): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: { "content-type": "application/xml" } });
}

function s3Error(status: number, code: string): Response {
  return xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);
}

export default {
  /**
   * POST /run/<op>?do=<name> with the op's params as JSON. The answer streams a space every
   * 15 s while the op runs, so a long install or FUSE copy keeps the client's connection
   * open; the driver trims before parsing.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name0 = url.searchParams.get("do");
    const started = url.pathname.match(/^\/start\/(\w+)$/);
    if (started && request.method === "POST" && name0) {
      const params = (await request.json()) as Params;
      return Response.json(await env.PROBE.get(env.PROBE.idFromName(name0)).start(started[1], params));
    }
    if (url.pathname === "/result" && name0) {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName(name0)).result());
    }
    const m = url.pathname.match(/^\/run\/(\w+)$/);
    if (!m || request.method !== "POST") return new Response("POST /run/<op>?do=<name>", { status: 404 });
    const name = url.searchParams.get("do") ?? crypto.randomUUID();
    const params = (await request.json()) as Params;
    const stub = env.PROBE.get(env.PROBE.idFromName(name));
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const beat = setInterval(() => void w.write(enc.encode(" ")), 15_000);
    const t0 = Date.now();
    void (async () => {
      let body: Result;
      try {
        body = { do: name, workerMs: 0, ...((await stub.run(m[1], params)) as Result) };
      } catch (e) {
        body = { do: name, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
      body.workerMs = Date.now() - t0;
      clearInterval(beat);
      await w.write(enc.encode(JSON.stringify(body)));
      await w.close();
    })();
    return new Response(readable, { headers: { "content-type": "application/json" } });
  },
};
