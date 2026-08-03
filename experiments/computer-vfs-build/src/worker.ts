// SPIKE — does @cloudflare/computer's FUSE-mounted VFS carry our real `vite build`?
//
// THE DESIGN POINT: a WITHIN-CONTAINER A/B. container-cold-start-probe measured colo as a
// ~3.5x nuisance variable (EWR 28.1s vs CMH 7.7s on the same config), and colo is ASSIGNED,
// not chosen — so comparing a fresh FUSE number against that experiment's 8-10s baseline
// across sessions would measure colo, not filesystems. Both arms therefore run back-to-back
// inside ONE container:
//
//   arm A (fuse) — source + dist live in /workspace, the computerd FUSE mirror of DO SQLite
//   arm B (disk) — source + dist live in /var/tmp,  the container's own ext4 disk
//
// Identical bytes, identical baked /node_modules, one boot, one colo. The headline is the
// RATIO; the absolute numbers are only cross-checkable against the earlier probe.
//
// TIMING: every mark is separated by an awaited RPC into the container, so Date.now()
// advances between them ([[cf-clock-traps]] #3 — "across awaits, Date.now() advances to
// reflect real elapsed wall-clock time"). The driver also times the whole request from
// outside as the external-observer sanity check that memory asks for.

import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

import { SEED_APP, SEED_BYTES, SEED_FILE_COUNT } from "./seed-app";

// Re-exported so the runtime can build the loopback binding the container's egress uses
// (ctx.exports.WorkspaceProxy). Without this the class is not in the Worker's module graph
// and the backend cannot wire container -> DO calls.
export { WorkspaceProxy };

/** VFS path for arm A. `/workspace` is computerd's MOUNT_POINT (Dockerfile). */
const FUSE_APP = "/workspace/app";
/** Container-local ext4 path for arm B — deliberately OUTSIDE the mount, so it is not synced. */
const DISK_APP = "/var/tmp/app";
/** Baked source for arm B, and the dep tree both arms resolve. */
const SEED_DIR = "/seed/app";
/** `vite` lives in the baked root-level tree; npm's bin resolution does not walk to `/`. */
const EXEC_ENV = {
  PATH: "/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  // Vite/rollup pick up NODE_ENV; pin it so neither arm silently takes a different path.
  NODE_ENV: "production",
};
const BUILD_TIMEOUT_MS = 180_000;

interface Step {
  name: string;
  ms: number;
  exitCode?: number;
  /** Sync accounting from WorkspaceRuntimeResult — how many entries crossed the bracket. */
  pushed?: number;
  pulled?: number;
  note?: string;
}

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "VfsBuildDO", id: this.ctx.id.toString() },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

export class VfsBuildDO extends withWorkspace(ContainerBase, workspaceOptions) {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // computerd dials back in over /ws; that upgrade belongs to the backend.
    if (url.pathname === "/ws" || request.headers.get("upgrade") === "websocket") {
      return this.backend.handleFetch(request);
    }
    if (url.pathname !== "/bench") return this.backend.handleFetch(request);

    try {
      const reps = Number(url.searchParams.get("reps") ?? "2");
      return Response.json(await this.#bench(reps));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), stack: (error as Error)?.stack },
        { status: 500 },
      );
    }
  }

  async #bench(reps: number) {
    const steps: Step[] = [];
    const ws = await getWorkspace(this);

    // A stopwatch whose marks are only ever taken around an await (see the TIMING note).
    let last = Date.now();
    const mark = (name: string, extra: Partial<Step> = {}) => {
      const now = Date.now();
      steps.push({ name, ms: now - last, ...extra });
      last = now;
    };

    const exec = async (name: string, command: string, cwd?: string) => {
      const handle = await ws.runtime.exec(command, {
        cwd,
        encoding: "utf8",
        env: EXEC_ENV,
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      const result = await handle.result();
      mark(name, {
        exitCode: result.exitCode,
        pushed: result.pushed,
        pulled: result.pulled,
        // Capture stdout even on success: the diag steps below answer their question through
        // what they PRINT, and a `... || echo MISSING` fallback exits 0 either way, so an
        // exit code alone cannot distinguish the two outcomes.
        note: result.exitCode === 0 ? `${result.stdout}`.trim().slice(-300) : `${result.stderr}`.slice(-600),
      });
      return result;
    };

    // ---- cold: force a fresh instance so the first exec pays real start + FUSE mount ----
    // `destroy()` is raw ctx.container (IWorkspaceContainerAPI exposes start/restart/status
    // but no destroy). Best-effort: on a first-ever run there is nothing to destroy.
    try {
      this.ctx.container?.destroy();
    } catch {
      /* nothing running */
    }
    mark("destroy");

    // First exec = container acquisition + computerd boot + FUSE mount + capnweb connect.
    // Directly comparable to the earlier probe's "cold start" term (0.3-1.6s there).
    const cold = await exec("cold_start_and_mount", "node -v");
    if (cold.exitCode !== 0) throw new Error(`container did not come up: ${cold.stderr}`);

    // Confirm we actually got the REAL kernel FUSE backend and not the userspace shim.
    // Under `wrangler dev` /dev/fuse is absent and FUSE_MOUNT=auto silently degrades, which
    // would make every number below meaningless — so record it rather than assume it.
    const mnt = await exec("probe_mount_type", `cat /proc/mounts | grep -E ' /workspace ' || echo NONE`);

    // ---- arm A source delivery: the realistic Galaxy path (ws.fs.writeFile per file) ----
    await ws.fs.mkdir(`${FUSE_APP}/src`, { recursive: true });
    for (const [rel, content] of Object.entries(SEED_APP)) {
      await ws.fs.writeFile(`${FUSE_APP}/${rel}`, content);
    }
    mark("write_seed_into_vfs", { note: `${SEED_FILE_COUNT} files / ${SEED_BYTES} B` });

    // ---- diagnostics for the arm-B failure (2026-08-03) ------------------------------
    // First run: `B_disk_prep` (rm -rf + cp -r into /var/tmp) exited 0, yet the NEXT exec
    // could not cwd into the directory it should have created. Two candidate causes, and
    // they have very different consequences for us, so probe rather than guess:
    //   (1) `&&` is not shell-interpreted, so only the `rm` ran and the `cp` never did;
    //   (2) container-local state OUTSIDE the mount does not survive between execs — which
    //       would mean /workspace is the only durable surface, a finding in its own right.
    await exec("diag_image_contents", "ls -la /seed /seed/app /var/tmp 2>&1 | head -40");
    await exec("diag_shell_chaining", "echo first && echo second");
    await exec("diag_write_outside_mount", "echo persisted > /var/tmp/probe.txt; cat /var/tmp/probe.txt");
    await exec("diag_read_outside_mount_next_exec", "cat /var/tmp/probe.txt 2>&1 || echo MISSING");

    // ---- equalizer: warm vite's dep-optimize cache BEFORE either measured arm ----
    // Both arms resolve /node_modules, so vite's .vite cache is SHARED. Without this the
    // first measured arm would pay to populate it and the second would free-ride — the
    // exact confound that would make whichever arm ran first look bad.
    // NOTE: `cwd` is validated at SPAWN, before the command runs, so a command that creates
    // its own cwd must `cd` into it instead of declaring it (the first run's bug).
    await exec("warmup_build_discarded", `rm -rf /var/tmp/warm && cp -r ${SEED_DIR} /var/tmp/warm && cd /var/tmp/warm && vite build`);

    for (let rep = 1; rep <= reps; rep++) {
      // arm A — build in the FUSE mount; dist lands in the VFS and syncs back to the DO.
      await exec(`A${rep}_fuse_build`, "rm -rf dist && vite build", FUSE_APP);
      // The moment dist is readable DO-side is what actually replaces "return dist" today.
      const html = await ws.fs.readFile(`${FUSE_APP}/dist/index.html`, "utf8");
      mark(`A${rep}_dist_readable_from_do`, { note: `${html.length} B` });

      // arm B — same bytes, same deps, container's own ext4 disk. Prep and build are ONE
      // exec so the comparison cannot be broken by cross-exec state loss; the `cp` is
      // disk-to-disk and measured separately below as its own control.
      await exec(
        `B${rep}_disk_build`,
        `rm -rf ${DISK_APP} && cp -r ${SEED_DIR} ${DISK_APP} && cd ${DISK_APP} && vite build`,
      );
      // Control: what the `rm`+`cp` prefix costs, so it can be subtracted from arm B.
      await exec(`B${rep}_prep_only_control`, `rm -rf /var/tmp/ctl && cp -r ${SEED_DIR} /var/tmp/ctl`);
    }

    // Colo, so results can be compared against container-cold-start-probe's colo table.
    // Placement does not follow the caller, so this must be asked of the container itself.
    const trace = await exec("probe_colo", "curl -s --max-time 5 https://cloudflare.com/cdn-cgi/trace || echo unavailable");
    const colo = /colo=([A-Z]+)/.exec(trace.stdout)?.[1] ?? "unknown";

    return {
      colo,
      mount: mnt.stdout.trim().slice(0, 300),
      seed: { files: SEED_FILE_COUNT, bytes: SEED_BYTES },
      steps,
      summary: summarize(steps, reps),
    };
  }
}

/** Pairs each rep's arms so the headline ratio is readable without post-processing. */
function summarize(steps: Step[], reps: number) {
  const ms = (name: string) => steps.find((s) => s.name === name)?.ms ?? NaN;
  const pairs = [];
  for (let rep = 1; rep <= reps; rep++) {
    const fuse = ms(`A${rep}_fuse_build`);
    const disk = ms(`B${rep}_disk_build`);
    pairs.push({
      rep,
      fuseBuildMs: fuse,
      diskBuildMs: disk,
      ratio: Number((fuse / disk).toFixed(2)),
      distReadbackMs: ms(`A${rep}_dist_readable_from_do`),
    });
  }
  return {
    coldStartAndMountMs: ms("cold_start_and_mount"),
    writeSeedIntoVfsMs: ms("write_seed_into_vfs"),
    pairs,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("GET /bench?reps=2&instance=<name> — within-container FUSE-vs-disk vite build A/B\n");
    }
    if (url.pathname !== "/bench") return new Response("not found", { status: 404 });

    // A fresh instance name per run gets fresh first-touch placement, matching how
    // container-cold-start-probe sampled colo (placement does not follow the caller).
    const name = url.searchParams.get("instance") ?? `run-${crypto.randomUUID()}`;
    const stub = env.VfsBuildDO.get(env.VfsBuildDO.idFromName(name));
    const started = Date.now();
    const res = await stub.fetch(new Request(`https://do/bench${url.search}`));
    const body = await res.json();
    // External-observer cross-check on the DO-side clock ([[cf-clock-traps]] default stance).
    return Response.json({ instance: name, observedTotalMs: Date.now() - started, ...(body as object) }, {
      status: res.status,
    });
  },
} satisfies ExportedHandler<Env>;
