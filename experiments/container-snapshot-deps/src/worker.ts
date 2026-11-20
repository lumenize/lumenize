// SPIKE — can container snapshots replace baking deps into Nebula's build-box image?
//
// One op per request, each on a FRESH Durable Object name (so a fresh container, with
// fresh placement), driven by scripts/drive.mjs. Every op starts a container, measures,
// and destroys it — the same ephemeral shape Nebula's Galaxy uses per build.
//
// Timing is DO-side Date.now() around AWAITED I/O, which advances the clock
// (the cf-clock-traps memory). The command server also times each command in-container.
import { DurableObject } from "cloudflare:workers";

// The container's command server, passed as the entrypoint at start() rather than baked
// into the image: one source of truth, and the managed cloudflare/debian-trixie image
// (which has node 24 but none of our files) runs the same server. `node -e` is CJS.
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
      const p = spawn("sh", ["-c", cmd], { cwd: cwd || "/", env: process.env });
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
const INSTANCE = "standard-2"; // what apps/nebula runs (its wrangler.jsonc says why)
const READY_DEADLINE_MS = 120_000;
// `@swc/core` >= 1.16.12 unpacks its native binding into ~/.cache and refuses to load it
// when any ancestor is "writable by another user without trusted sticky protection".
// Deployed, `/` is owned by uid 2346 (locally it is root), so every build fails with
// ERR_SWC_NATIVE_CACHE — and SWC_NATIVE_BINDING_CACHE=/tmp/… does not help, since `/` is
// still an ancestor. Handing `/` back to root does. Harmless locally.
const BUILD = "chown 0:0 / 2>/dev/null; npx vite build";

type ImageName = "plain" | "plain2" | "baked" | "trixie";
type Handle = { id: string; size: number; name?: string; dir?: string };
type ExecResult = { code: number | null; ms: number; out: string; err: string };

interface Params {
  image?: ImageName;
  /** Leave `image` out of start() — does the policy require it? (computer 0.3.1 never passes one.) */
  omitImage?: boolean;
  install?: boolean;
  build?: boolean;
  kind?: "container" | "dir";
  handle?: Handle;
  mountPoint?: string;
  /** start() with only what the DEFAULT scheduling policy takes: no image, no instance. */
  bare?: boolean;
  /** `start` only: a diagnostic command to run once ready. */
  cmd?: string;
  /** Overrides `npx vite build` (e.g. to set SWC_NATIVE_BINDING_CACHE). */
  buildCmd?: string;
}

// The generated types make `image` and `containerSnapshot` mutually exclusive (a
// snapshot carries its image). `omitImage` deliberately breaks that to ask the RUNTIME
// whether a bare start() — all @cloudflare/computer 0.3.1 sends — is accepted.
type StartOptions = Omit<ContainerStartupOptions, "image" | "containerSnapshot"> & {
  image?: string;
  containerSnapshot?: ContainerSnapshotRestoreParams;
};

export class Probe extends DurableObject<Env> {
  async run(op: string, p: Params): Promise<Record<string, unknown>> {
    const r: Record<string, unknown> = { op, image: p.image, kind: p.kind };
    try {
      if (op === "start") await this.#opStart(p, r);
      else if (op === "fresh") await this.#opFresh(p, r);
      else if (op === "snap") await this.#opSnap(p, r);
      else if (op === "restore") await this.#opRestore(p, r);
      else if (op === "resnap") await this.#opResnap(p, r);
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

  /** start() then poll /health; returns start→ready ms. start() returns before ready. */
  async #start(p: Params, r: Record<string, unknown>, extra: Partial<StartOptions> = {}): Promise<void> {
    const opts: StartOptions = {
      enableInternet: !!p.install,
      instance: INSTANCE,
      entrypoint: ["node", "-e", SERVER],
      ...extra,
    };
    if (p.bare) delete opts.instance;
    if (!p.omitImage && !p.bare && !opts.containerSnapshot) {
      opts.image = p.image === "trixie" ? "cloudflare/debian-trixie" : this.#c.images[p.image ?? "plain"];
    }
    r.imageRef = opts.image;
    const t0 = Date.now();
    try {
      this.#c.start(opts as ContainerStartupOptions);
    } catch (e) {
      r.startError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw e;
    }
    // containers.md: attach monitor() or `.running` lies. We never read `.running`, but a
    // crash-on-boot surfaces here rather than as a silent readiness timeout.
    this.#c.monitor().catch((e: unknown) => {
      console.log("monitor", e instanceof Error ? e.message : String(e));
    });
    let lastErr = "";
    while (Date.now() - t0 < READY_DEADLINE_MS) {
      try {
        const res = await this.#c.getTcpPort(PORT).fetch("http://container/health");
        if (res.ok) {
          r.readyMs = Date.now() - t0;
          r.mark = ((await res.json()) as { mark: string }).mark;
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

  async #exec(cmd: string, cwd = "/app"): Promise<ExecResult> {
    const res = await this.#c.getTcpPort(PORT).fetch("http://container/exec", {
      method: "POST",
      body: JSON.stringify({ cmd, cwd }),
    });
    return (await res.json()) as ExecResult;
  }

  /** Record an exec's time and exit, keeping only a tail of output, and only on failure. */
  #keep(r: Record<string, unknown>, key: string, x: ExecResult): void {
    r[`${key}Ms`] = x.ms;
    r[`${key}Code`] = x.code;
    if (x.code !== 0) r[`${key}Tail`] = (x.err || x.out).slice(-1500);
  }

  async #treeFacts(r: Record<string, unknown>): Promise<void> {
    const x = await this.#exec(
      "echo pkgs=$(ls node_modules 2>/dev/null | wc -l) mb=$(du -sm node_modules 2>/dev/null | cut -f1); " +
        "touch node_modules/.probe-write 2>/dev/null && echo writable=yes || echo writable=no; " +
        "grep ' /app/node_modules ' /proc/mounts || echo mount=none",
    );
    r.tree = x.out.trim();
  }

  async #destroy(): Promise<void> {
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
    } catch {
      // already gone
    }
  }

  // ── ops ────────────────────────────────────────────────────────────────────

  /** Cold start → ready, plus what the box is. */
  async #opStart(p: Params, r: Record<string, unknown>): Promise<void> {
    await this.#start(p, r);
    const x = await this.#exec("node --version; nproc; free -m | sed -n 2p", "/");
    r.box = x.out.trim();
    if (p.cmd) {
      const d = await this.#exec(p.cmd, "/");
      r.cmdOut = (d.out + d.err).trim();
    }
  }

  /** No snapshot: baked image builds as-is, or plain image installs then builds. */
  async #opFresh(p: Params, r: Record<string, unknown>): Promise<void> {
    await this.#start(p, r);
    if (p.install) {
      this.#keep(r, "install", await this.#exec("npm ci --include=dev --no-audit --no-fund"));
      const colo = await this.#exec(
        `node -e 'fetch("https://www.cloudflare.com/cdn-cgi/trace").then(r=>r.text()).then(t=>console.log((t.match(/colo=\\w+/)||["?"])[0]))'`,
      );
      r.colo = colo.out.trim();
    }
    if (p.build) this.#keep(r, "build", await this.#exec(p.buildCmd ?? BUILD));
    await this.#treeFacts(r);
  }

  /** Install on the plain image, prove the tree builds, then snapshot it both ways. */
  async #opSnap(p: Params, r: Record<string, unknown>): Promise<void> {
    await this.#start({ ...p, install: true }, r);
    this.#keep(r, "install", await this.#exec("npm ci --include=dev --no-audit --no-fund"));
    this.#keep(r, "build", await this.#exec(`${p.buildCmd ?? BUILD} && rm -rf dist`));
    await this.#treeFacts(r);

    let t0 = Date.now();
    try {
      r.containerSnapshot = await this.#c.snapshotContainer({ name: `probe-${this.ctx.id}` });
      r.containerSnapMs = Date.now() - t0;
    } catch (e) {
      r.containerSnapError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    // snapshotDirectory is in the runtime types at compat 2026-08-15 (apps/nebula's) and
    // gone from them at 2026-09-29, while its restore params remain — so ask the runtime.
    const snapDir = (this.#c as unknown as { snapshotDirectory?: (o: { dir: string; name?: string }) => Promise<ContainerDirectorySnapshot> })
      .snapshotDirectory;
    r.snapshotDirectoryType = typeof snapDir;
    if (typeof snapDir === "function") {
      t0 = Date.now();
      try {
        r.dirSnapshot = await snapDir.call(this.#c, { dir: "/app/node_modules", name: `probe-dir-${this.ctx.id}` });
        r.dirSnapMs = Date.now() - t0;
      } catch (e) {
        r.dirSnapError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }
  }

  /**
   * The per-Galaxy delta: restore the shared snapshot WITH internet, add one package,
   * snapshot again. Is the second snapshot a small delta or a full copy?
   */
  async #opResnap(p: Params, r: Record<string, unknown>): Promise<void> {
    if (!p.handle) throw new Error("resnap needs a handle");
    await this.#start({ ...p, install: true }, r, { containerSnapshot: { id: p.handle.id } });
    this.#keep(r, "install", await this.#exec("npm install --no-audit --no-fund dayjs"));
    const t0 = Date.now();
    r.containerSnapshot = await this.#c.snapshotContainer({ name: `probe-delta-${this.ctx.id}` });
    r.containerSnapMs = Date.now() - t0;
  }

  /** Start from a snapshot with NO internet, then prove the restored tree builds. */
  async #opRestore(p: Params, r: Record<string, unknown>): Promise<void> {
    if (!p.handle) throw new Error("restore needs a handle");
    const extra: Partial<StartOptions> =
      p.kind === "dir"
        ? { directorySnapshots: [{ snapshot: p.handle as ContainerDirectorySnapshot, mountPoint: p.mountPoint ?? "/app/node_modules" }] }
        : { containerSnapshot: { id: p.handle.id } };
    await this.#start({ ...p, install: false }, r, extra);
    r.inspect = await this.#c.inspect().catch((e: unknown) => `inspect failed: ${e instanceof Error ? e.message : String(e)}`);
    await this.#treeFacts(r);
    this.#keep(r, "build", await this.#exec(p.buildCmd ?? BUILD));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/run\/(\w+)$/);
    if (!m || request.method !== "POST") return new Response("POST /run/<op>?do=<name>", { status: 404 });
    const name = url.searchParams.get("do") ?? crypto.randomUUID();
    const stub = env.PROBE.get(env.PROBE.idFromName(name));
    const t0 = Date.now();
    try {
      const result = (await stub.run(m[1], (await request.json()) as Params)) as Record<string, unknown>;
      return Response.json({ do: name, workerMs: Date.now() - t0, ...result });
    } catch (e) {
      return Response.json({ do: name, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  },
};
