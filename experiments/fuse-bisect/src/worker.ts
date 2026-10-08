// SPIKE — the deployed-FUSE bisect (2026-08-29). Arm A (the redeployed
// computer-vfs-build experiment) already proved the PLATFORM serves the mount today:
// seed → vite build through kernel FUSE → dist, including the recycle case. So the
// mount-serves-empty blocker is in GALAXY'S WIRING, and this worker walks the deltas
// between the two shapes one query param at a time until one reds:
//
//   shape=mixin|direct  withWorkspace/getWorkspace (experiment) vs a hand-constructed
//                       `new Workspace` + WorkspaceContainerAPI thunks (galaxy.ts
//                       #constructWorkspace)
//   git=0|1             construct with createGitClient() + defaultGitIdentity, and
//                       init/add/commit the seeded files (Galaxy's onStart does)
//   where=app|root      seed under /app (experiment) vs at the VFS root (Galaxy)
//   warm=0|1            pre-start the container via WorkspaceContainerAPI.start({})
//                       BEFORE the first exec (Galaxy's warmBuildBox) — the backend's
//                       connect() then finds `.running` true and never re-applies its
//                       own env (PORT/MOUNT_POINT ride the image's ENV defaults either
//                       way; what differs is which code path launched the container)
//   cycles=1|2          run a second exec after destroy()+reconstruct (Galaxy's
//                       per-build teardown; direct shape only reconstructs)
//
// Galaxy's full shape: ?shape=direct&git=1&where=root&warm=1&cycles=2
// The experiment's:    ?shape=mixin&git=0&where=app&warm=0&cycles=1
// Use a FRESH ?do= name per run — each arm wants virgin storage.
import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  Workspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import {
  CloudflareContainerBackend,
  WorkspaceContainerAPI,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

// Re-exported so the runtime can build the loopback binding the container's egress uses
// (ctx.exports.WorkspaceProxy) — same note as the original experiment.
export { WorkspaceProxy };

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "FuseBisectDO", id: this.ctx.id.toString() },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

interface ExecProbe {
  exitCode: number;
  stdout: string;
  stderr: string;
  pushed?: number;
  pulled?: number;
}

export class FuseBisectDO extends withWorkspace(ContainerBase, workspaceOptions) {
  // The Galaxy-shaped construction — mirrors galaxy.ts #constructWorkspace field for field.
  #directBackend?: CloudflareContainerBackend;
  #directWs?: Workspace;
  #containerApi?: WorkspaceContainerAPI;
  // /ws dial-backs arrive as separate requests mid-probe; route them to the active shape.
  #active: "mixin" | "direct" = "mixin";

  #constructDirect(git: boolean): void {
    this.#directBackend = new CloudflareContainerBackend({
      container: () => ({
        getWorkspaceContainer: () => (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)),
      }),
      workspace: { binding: "FuseBisectDO", id: this.ctx.id.toString() },
    });
    this.#directWs = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      ...(git
        ? { git: createGitClient(), defaultGitIdentity: { name: "bisect", email: "bisect@lumenize.io" } }
        : {}),
      backends: [this.#directBackend],
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || request.headers.get("upgrade") === "websocket") {
      return this.#active === "direct" && this.#directBackend
        ? this.#directBackend.handleFetch(request)
        : this.backend.handleFetch(request);
    }
    if (url.pathname !== "/probe") return new Response("try /probe", { status: 404 });

    try {
      const shape = url.searchParams.get("shape") === "direct" ? "direct" : "mixin";
      const git = url.searchParams.get("git") === "1";
      // where=mount is the hypothesis arm: the mount serves the VFS's /workspace SUBTREE
      // (computerd mirrors the mount at the same absolute path — the boot pull materializes
      // a `workspace` dir in the VFS root), so host writes must carry the /workspace prefix.
      // The original experiment's FUSE_APP was literally "/workspace/app".
      const where = url.searchParams.get("where") ?? "app";
      const warm = url.searchParams.get("warm") === "1";
      const cycles = url.searchParams.get("cycles") === "2" ? 2 : 1;
      // order=pre seeds BEFORE the first exec (Galaxy's onStart shape); order=post runs a
      // boot exec first — the original experiment's order, where the push rides an
      // ALREADY-ESTABLISHED session on the next bracket.
      const order = url.searchParams.get("order") === "post" ? "post" : "pre";
      // execs=2 re-runs the look on the SAME session — does late FUSE invalidation
      // deliver what the first look missed?
      const execs = url.searchParams.get("execs") === "2" ? 2 : 1;
      this.#active = shape;
      if (shape === "direct") this.#constructDirect(git);
      const ws = shape === "direct" ? this.#directWs! : await getWorkspace(this);
      const steps: Record<string, unknown> = { arm: { shape, git, where, warm, cycles, order, execs } };

      const base = where === "root" ? "" : where === "mount" ? "/workspace/app" : "/app";
      const seed = async (): Promise<void> => {
        await ws.fs.mkdir(`${base}/src`, { recursive: true });
        await ws.fs.writeFile(`${base}/probe.txt`, "bisect-probe");
        await ws.fs.writeFile(`${base}/src/App.vue`, "<template>bisect</template>");
        if (git) {
          // On the mount arm the repo roots at /workspace (Galaxy's fixed shape: .git rides
          // the mount like a normal checkout); elsewhere at the VFS root as before.
          const dir = where === "mount" ? "/workspace" : "/";
          const rel = (p: string): string => p.replace(/^\/+/, "").replace(/^workspace\//, "");
          await ws.git.init({ dir, defaultBranch: "main" });
          await ws.git.add({ dir, paths: [`${base}/probe.txt`, `${base}/src/App.vue`].map(rel) });
          await ws.git.commit({ dir, message: "scaffold" });
        }
        steps.seeded = { base: base || "/", git, hostSees: await ws.fs.readdir("/") };
      };

      if (warm) {
        // Galaxy's warmBuildBox: launch through WorkspaceContainerAPI with EMPTY env,
        // before any backend connect. (0.1.1's start takes env only.)
        await (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)).start({});
        steps.warmed = true;
      }

      const exec = async (command: string): Promise<ExecProbe> => {
        const handle = await ws.runtime.exec(command, {
          cwd: "/workspace",
          encoding: "utf8",
          timeoutMs: 120_000,
        });
        const r = await handle.result();
        return {
          exitCode: r.exitCode,
          stdout: (r.stdout as string).slice(0, 1500),
          stderr: (r.stderr as string).slice(0, 400),
          pushed: (r as { pushed?: number }).pushed,
          pulled: (r as { pulled?: number }).pulled,
        };
      };

      // Under the subtree mapping the container path for a VFS path P is P itself when P
      // already starts with /workspace; the app/root arms have no container-side home.
      const ctnProbe = where === "mount" ? `${base}/probe.txt` : `/workspace${base}/probe.txt`;
      const look = `sh -c 'grep fuse /proc/mounts; ls -la /workspace /workspace/app 2>&1; cat ${ctnProbe} 2>&1'`;
      if (order === "pre") {
        await seed();
      } else {
        steps.boot = await exec("node -v");
        await seed();
      }
      steps.cycle1 = await exec(look);
      if (execs === 2) steps.cycle1b = await exec(look);

      if (cycles === 2) {
        // Galaxy's #destroyBuildContainer: destroy, drop the api, reconstruct.
        try {
          void this.ctx.container?.destroy()?.catch(() => {});
        } catch { /* sync throw */ }
        this.#containerApi = undefined;
        if (shape === "direct") this.#constructDirect(git);
        const ws2 = shape === "direct" ? this.#directWs! : await getWorkspace(this);
        const handle = await ws2.runtime.exec(look, { cwd: "/workspace", encoding: "utf8", timeoutMs: 120_000 });
        const r = await handle.result();
        steps.cycle2 = {
          exitCode: r.exitCode,
          stdout: (r.stdout as string).slice(0, 1500),
          stderr: (r.stderr as string).slice(0, 400),
          pushed: (r as { pushed?: number }).pushed,
          pulled: (r as { pulled?: number }).pulled,
        };
      }

      return Response.json(steps);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), stack: (error as Error)?.stack },
        { status: 500 },
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("do") ?? "bisect-1";
    return env.FuseBisectDO.get(env.FuseBisectDO.idFromName(name)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
