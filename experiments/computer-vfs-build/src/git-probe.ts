// SECONDARY (d): does HOST-SIDE `file://` git actually work, or is it only allowed by the
// scheme gate?
//
// Why this matters: the "git as the transport" candidate in nebula-galaxy-collapse-and-chat.md
// asks whether two repos inside ONE Workspace can talk to each other without a git server
// (and therefore without Cloudflare Artifacts, still closed beta). `docs/13_git_interface.md`
// says "https://, http://, and file:// are the only supported URL schemes", and
// `git/cli.ts`'s isSupportedTransport does permit file:// — but `git/network.ts` hands
// `http:` to isomorphic-git for every network op, no test in the repo mentions file://, and
// upstream isomorphic-git has no local transport. So: allowed by the gate, unproven.
//
// This probe needs NO CONTAINER — a Workspace constructed without `backends` is
// filesystem-only ("Omit it to construct a filesystem-only Workspace"), so it runs under a
// plain `wrangler dev` with no Docker involved. That is deliberate: it is the half of the
// spike that stays reachable when the container half is blocked.

import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  Workspace,
} from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";

const IDENTITY = { name: "spike", email: "spike@lumenize.test" };

interface Attempt {
  step: string;
  ok: boolean;
  detail: string;
}

export class GitProbeDO extends DurableObject<Env> {
  #ws?: Workspace;

  get ws(): Workspace {
    this.#ws ??= new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      git: createGitClient(),
      defaultGitIdentity: IDENTITY,
      // No `backends` — filesystem-only. Everything below runs on the DO thread against
      // the DO's own SQLite.
    });
    return this.#ws;
  }

  override async fetch(): Promise<Response> {
    const attempts: Attempt[] = [];
    const record = async (step: string, fn: () => Promise<unknown>) => {
      try {
        const value = await fn();
        attempts.push({ step, ok: true, detail: summarize(value) });
        return true;
      } catch (error) {
        attempts.push({
          step,
          ok: false,
          detail: `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`,
        });
        return false;
      }
    };

    const ws = this.ws;
    const git = ws.git;

    // ---- source repo: /a, one real commit -------------------------------------------
    await record("rm -rf /a /b", async () => {
      await ws.fs.rm("/a", { recursive: true, force: true });
      await ws.fs.rm("/b", { recursive: true, force: true });
      return "clean";
    });
    await record("mkdir /a", () => ws.fs.mkdir("/a", { recursive: true }));
    await record("git init /a", () => git.init({ dir: "/a", initialBranch: "main" }));
    await record("write /a/hello.txt", () => ws.fs.writeFile("/a/hello.txt", "hello from /a\n"));
    await record("git add", () => git.add({ dir: "/a", paths: ["hello.txt"] }));
    await record("git commit", () =>
      git.commit({ dir: "/a", message: "seed", author: IDENTITY }),
    );

    // ---- THE QUESTION: can /b be created from /a with no server? ---------------------
    const cloned = await record("git clone file:///a -> /b", () =>
      git.clone({ dir: "/b", url: "file:///a" }),
    );

    // Fetch/pull path too — a clone failure and a pull failure are different findings:
    // clone is what a scaffold-provision would use, pull is what a promote would use.
    await record("mkdir /b2 + init", async () => {
      await ws.fs.mkdir("/b2", { recursive: true });
      return git.init({ dir: "/b2", initialBranch: "main" });
    });
    await record("git remote add origin file:///a", () =>
      git.remoteAdd({ dir: "/b2", name: "origin", url: "file:///a" }),
    );
    await record("git pull origin main (file://)", () =>
      git.pull({ dir: "/b2", remote: "origin", remoteRef: "main" }),
    );

    // Control: prove the scheme gate is not what rejects it, by showing an unsupported
    // scheme fails DIFFERENTLY (a transport rejection, not whatever file:// does).
    await record("CONTROL git clone ssh://... (expect scheme rejection)", () =>
      git.clone({ dir: "/c", url: "ssh://git@example.com/x.git" }),
    );

    if (cloned) {
      await record("read /b/hello.txt (proves clone materialized)", () =>
        ws.fs.readFile("/b/hello.txt", "utf8"),
      );
    }

    return Response.json({
      verdict: cloned ? "file:// CLONE WORKS host-side" : "file:// clone FAILED host-side",
      attempts,
    });
  }
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return JSON.stringify(value).slice(0, 300);
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const stub = env.GitProbeDO.get(env.GitProbeDO.idFromName(`probe-${crypto.randomUUID()}`));
    return stub.fetch(new Request("https://do/"));
  },
} satisfies ExportedHandler<Env>;
