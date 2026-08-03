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
      const mode = url.searchParams.get("mode");
      if (mode === "hybrid") return Response.json(await this.#hybrid());
      if (mode === "install") {
        return Response.json(await this.#installTurn(
          url.searchParams.get("deps") ?? "echarts",
          url.searchParams.get("into") ?? "ext4",
        ));
      }
      if (mode) return Response.json(await this.#incremental(mode));
      const reps = Number(url.searchParams.get("reps") ?? "2");
      return Response.json(await this.#bench(reps));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), stack: (error as Error)?.stack },
        { status: 500 },
      );
    }
  }

  /**
   * ROUND 2 (2026-08-03) — the incrementalism question the first round did NOT ask.
   *
   * Round 1 baked `node_modules` into the image, OUTSIDE the mount, and recommended keeping it
   * there. That recommendation silently assumed the deps question was settled — but the
   * container is EPHEMERAL, so anything not baked is reinstalled from scratch on every build.
   * Putting `node_modules` INSIDE the mount changes the shape completely: the VFS lives in
   * Galaxy's SQLite, so it survives container death, and a turn that adds no dependency does
   * no install at all. FUSE being ~2x slower at `npm install` only matters on the rare turn
   * that installs; it is the wrong thing to optimise if the common turn can skip installing.
   *
   * Three modes, run in sequence against ONE instance:
   *   seed    — copy the baked tree into the VFS once. The one-time cost.
   *   warm    — build with source AND deps in the mount, no install.
   *   recycle — destroy() + start() (a genuinely new container), then build again with NO
   *             seed step. If this works, deps survived container death and the common turn
   *             costs zero install.
   */
  async #incremental(mode: string) {
    const steps: Step[] = [];
    const ws = await getWorkspace(this);
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
        note: result.exitCode === 0 ? `${result.stdout}`.trim().slice(-400) : `${result.stderr}`.slice(-600),
      });
      return result;
    };

    if (mode === "recycle") {
      // A genuinely new container. If the VFS is the durable surface, /workspace/node_modules
      // is still there on the other side and no install is needed.
      try {
        this.ctx.container?.destroy();
      } catch {
        /* nothing running */
      }
      mark("destroy");
    }

    await exec("boot", "node -v");

    if (mode === "seed") {
      // Source into the VFS the way codegen would.
      await ws.fs.mkdir(`${FUSE_APP}/src`, { recursive: true });
      for (const [rel, content] of Object.entries(SEED_APP)) {
        await ws.fs.writeFile(`${FUSE_APP}/${rel}`, content);
      }
      mark("write_seed_into_vfs", { note: `${SEED_FILE_COUNT} files / ${SEED_BYTES} B` });
      await exec("measure_baked_deps", "du -sh /node_modules && find /node_modules -type f | wc -l");
      // THE ONE-TIME COST: the whole dep tree crossing into DO SQLite through FUSE.
      await exec("copy_deps_into_vfs", `rm -rf /workspace/node_modules && cp -r /node_modules /workspace/node_modules`);
      await exec("verify_deps_in_vfs", "du -sh /workspace/node_modules && find /workspace/node_modules -type f | wc -l");
    }

    // Does Tailwind's NATIVE oxide binary exist and is it what the build actually uses? This is
    // the capability that forced a container in the first place ([[studio-keep-container-native-tide]]),
    // so "the build ran" is not the same claim as "oxide ran".
    await exec("probe_oxide_native", "find /node_modules/@tailwindcss -name '*.node' -o -name 'oxide*' -maxdepth 2 | head -20");

    const where = mode === "seed" ? "seed" : mode;
    await exec(`${where}_build_deps_from_vfs`, "rm -rf dist && vite build 2>&1 | tail -20", FUSE_APP);
    // Proof the CSS was really generated by Tailwind rather than silently skipped.
    await exec(`${where}_dist_listing`, `ls -la ${FUSE_APP}/dist ${FUSE_APP}/dist/assets 2>&1 | head -20`);
    await exec(`${where}_css_probe`, `cat ${FUSE_APP}/dist/assets/*.css 2>/dev/null | wc -c && grep -l 'tailwind\\|--tw-' ${FUSE_APP}/dist/assets/*.css 2>/dev/null | head -2`);

    return { mode, steps };
  }

  /**
   * ROUND 3 (2026-08-03) — the three hybrids.
   *
   * Round 2 measured the two ENDPOINTS: all deps baked on ext4 (~4.5 s/build) vs all deps in
   * the VFS (~6.8 s/build, durable across container death). Neither is the shape we would
   * ship. Three candidates, all using `lucide-vue-next` as the stand-in "user-added dep"
   * because the seed App.vue genuinely imports from it, so the build really resolves it:
   *
   *   H1  resolution-walk hybrid — baked set stays on ext4 at /node_modules, the user dep
   *       lives in the VFS at /workspace/app/node_modules. Node's upward walk finds the
   *       nearer (VFS) copy first. Only the user's own packages pay FUSE.
   *   H2  copy-in hybrid (Larry's) — the user dep is DURABLE in the VFS but is bulk-copied
   *       onto ext4 before the build, so the build itself touches no FUSE for deps. Trades
   *       one sequential copy against thousands of small FUSE reads. The vendor's bench
   *       splits on exactly this axis, so it is not obvious which wins.
   *   H3  npm-cache hybrid — leave node_modules alone entirely and persist npm's CACHE in
   *       the VFS, so a real `npm install` runs offline. Needs registry egress to evaluate
   *       honestly, which is itself worth probing given the backend installs an
   *       interceptOutboundHttp hook on connect.
   */
  async #hybrid() {
    const steps: Step[] = [];
    const ws = await getWorkspace(this);
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
      const r = await handle.result();
      mark(name, {
        exitCode: r.exitCode,
        pushed: r.pushed,
        pulled: r.pulled,
        note: r.exitCode === 0 ? `${r.stdout}`.trim().slice(-300) : `${r.stderr}`.slice(-400),
      });
      return r;
    };

    const USER_DEP = "lucide-vue-next"; // the seed App.vue imports { House } from this
    const VFS_DEPS = `${FUSE_APP}/node_modules`;

    await exec("boot", "node -v");

    // Source into the VFS, as codegen would.
    await ws.fs.mkdir(`${FUSE_APP}/src`, { recursive: true });
    for (const [rel, content] of Object.entries(SEED_APP)) {
      await ws.fs.writeFile(`${FUSE_APP}/${rel}`, content);
    }
    mark("write_seed_into_vfs", { note: `${SEED_FILE_COUNT} files / ${SEED_BYTES} B` });

    await exec("measure_user_dep", `du -sh /node_modules/${USER_DEP} && find /node_modules/${USER_DEP} -type f | wc -l`);

    // ---- H0: control — everything baked on ext4, source in the VFS (round 1's shape) -----
    await exec("H0_all_baked_build", "rm -rf dist && vite build 2>&1 | tail -3", FUSE_APP);

    // ---- H1: resolution-walk hybrid ------------------------------------------------------
    // Move the user dep into the VFS and DELETE it from ext4, so resolution is forced to the
    // FUSE copy. Deleting is what makes this a real test rather than a shadowed no-op.
    await exec("H1_setup_move_dep_to_vfs",
      `mkdir -p ${VFS_DEPS} && cp -r /node_modules/${USER_DEP} ${VFS_DEPS}/${USER_DEP} && rm -rf /node_modules/${USER_DEP}`);
    await exec("H1_verify_resolution",
      `node -e "console.log(require.resolve('${USER_DEP}/package.json',{paths:['${FUSE_APP}']}))"`);
    await exec("H1_build_dep_from_vfs", "rm -rf dist && vite build 2>&1 | tail -3", FUSE_APP);

    // ---- H2: copy-in hybrid — durable in VFS, bulk-copied to ext4 before building ---------
    await exec("H2_copy_vfs_dep_to_ext4", `cp -r ${VFS_DEPS}/${USER_DEP} /node_modules/${USER_DEP}`);
    // Hide the VFS copy so the build cannot silently keep using it.
    await exec("H2_hide_vfs_dep", `mv ${VFS_DEPS}/${USER_DEP} ${VFS_DEPS}/.${USER_DEP}-hidden`);
    await exec("H2_verify_resolution",
      `node -e "console.log(require.resolve('${USER_DEP}/package.json',{paths:['${FUSE_APP}']}))"`);
    await exec("H2_build_dep_from_ext4", "rm -rf dist && vite build 2>&1 | tail -3", FUSE_APP);

    // ---- H3 groundwork: is the registry even reachable, and where does npm cache? ---------
    // The container backend calls interceptOutboundHttp(egressHost, workspace) on connect, so
    // "does a tenant container have npm egress" is a live question, not an assumption.
    await exec("H3_probe_npm_cache_dir", "npm config get cache && du -sh $(npm config get cache) 2>/dev/null || echo no-cache-yet");
    await exec("H3_probe_registry_egress",
      "curl -s -o /dev/null -w 'registry_http=%{http_code} time=%{time_total}s' --max-time 20 https://registry.npmjs.org/lucide-vue-next || echo EGRESS_BLOCKED");

    return { steps };
  }

  /**
   * ROUND 4 (2026-08-03) — "is the whole turn just under 10s anyway?" (Larry)
   *
   * Every install number quoted so far came from container-cold-start-probe measuring a
   * DIFFERENT app. This measures the real worst case in THIS setup, end to end, on a cold
   * container: boot + FUSE mount + `npm install <serious deps>` + `vite build` + dist back.
   *
   * The placement detail that matters: the user's package.json lives in the VFS, so a naive
   * `npm install` in that directory writes node_modules into FUSE — the slow combination
   * round 3 measured. Installing with `--prefix /` puts the tree on ext4 instead, where
   * node's upward resolution still finds it, keeping the dep DECLARATION durable while the
   * dep TREE stays ephemeral and fast. Both are measured so the difference is visible.
   */
  async #installTurn(depsParam: string, into: string) {
    const steps: Step[] = [];
    const ws = await getWorkspace(this);
    let last = Date.now();
    const t0 = last;
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
      const r = await handle.result();
      mark(name, {
        exitCode: r.exitCode,
        pushed: r.pushed,
        pulled: r.pulled,
        note: r.exitCode === 0 ? `${r.stdout}`.trim().slice(-260) : `${r.stderr}`.slice(-400),
      });
      return r;
    };

    // NOTE: no explicit destroy() here. Doing it after getWorkspace() opens the session is
    // exactly the 1006 trap this spike recorded (§7d) — and a fresh `?instance=` name already
    // yields a cold container, which is what the measurement needs.
    await exec("cold_boot_and_mount", "node -v");
    const coldEnd = Date.now();

    await ws.fs.mkdir(`${FUSE_APP}/src`, { recursive: true });
    for (const [rel, content] of Object.entries(SEED_APP)) {
      await ws.fs.writeFile(`${FUSE_APP}/${rel}`, content);
    }
    mark("write_seed_into_vfs");

    // ROUND 4b: the http(s)-import arm. If the dep is imported from a CDN URL instead of npm,
    // vite externalises it -- no install AND no bundling. Round 4 showed bundling is the
    // dominant term, so this is the arm that actually tests whether the http(s)-imports-only
    // proposal is worth its restriction.
    if (into === "http") {
      const urls = depsParam.split(/\s+/).filter(Boolean).map((d) => `https://esm.sh/${d}`);
      await exec(
        "append_http_imports",
        urls.map((u) => `printf 'import "%s";\\n' '${u}' >> ${FUSE_APP}/src/main.ts`).join(" && ") +
          ` && tail -3 ${FUSE_APP}/src/main.ts`,
      );
      const t = Date.now();
      await exec("build", "rm -rf dist && node /node_modules/vite/bin/vite.js build 2>&1 | tail -6", FUSE_APP);
      const b = Date.now();
      let h = "";
      try {
        h = await ws.fs.readFile(`${FUSE_APP}/dist/index.html`, "utf8");
      } catch {
        mark("dist_MISSING");
      }
      if (h) mark("dist_readable_from_do", { note: `${h.length} B` });
      return {
        deps: depsParam,
        installedInto: into,
        totals: { coldBootAndMountMs: coldEnd - t0, npmInstallMs: 0, buildMs: b - t, wholeTurnMs: Date.now() - t0 },
        steps,
      };
    }

    // `--prefix /` -> ext4 (fast, ephemeral). cwd=/workspace/app -> FUSE (slow, durable).
    const installCmd =
      into === "vfs"
        ? `npm install --no-audit --no-fund --include=dev ${depsParam}`
        : `npm install --no-audit --no-fund --include=dev --prefix / ${depsParam}`;
    const installCwd = into === "vfs" ? FUSE_APP : undefined;
    await exec("npm_install", `${installCmd} 2>&1 | tail -4`, installCwd);
    const installEnd = Date.now();

    const depRoot = into === "vfs" ? `${FUSE_APP}/node_modules` : "/node_modules";
    await exec("measure_installed", `du -sh ${depRoot} && find ${depRoot} -type f | wc -l`);
    // `npm install --prefix /` left `vite: not found` twice. Look rather than guess again:
    // is the package gone, or only its .bin symlink?
    await exec("diag_after_install", `ls -d /node_modules/vite 2>&1; ls /node_modules/.bin 2>&1 | head -8; echo "--bin count:"; ls /node_modules/.bin 2>/dev/null | wc -l`);
    // Make the new deps actually part of the build, otherwise this measures nothing.
    if (depsParam.trim()) await exec("import_new_deps", `printf 'import "%s";\\n' ${depsParam.split(/\s+/).filter(Boolean).map((d) => `'${d}'`).join(" ")} >> ${FUSE_APP}/src/main.ts && tail -4 ${FUSE_APP}/src/main.ts`);
    await exec("build", "rm -rf dist && node /node_modules/vite/bin/vite.js build 2>&1 | tail -4", FUSE_APP);
    const buildEnd = Date.now();

    let html = "";
    try {
      html = await ws.fs.readFile(`${FUSE_APP}/dist/index.html`, "utf8");
    } catch (e) {
      mark("dist_MISSING", { note: `${(e as Error)?.message}`.slice(0, 200) });
    }
    if (html) mark("dist_readable_from_do", { note: `${html.length} B` });

    return {
      deps: depsParam,
      installedInto: into,
      totals: {
        coldBootAndMountMs: coldEnd - t0,
        npmInstallMs: installEnd - coldEnd,
        buildMs: buildEnd - installEnd,
        wholeTurnMs: Date.now() - t0,
      },
      steps,
    };
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
