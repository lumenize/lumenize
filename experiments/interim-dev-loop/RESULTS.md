# Interim dev-loop — RESULTS

Proves the interim (pre-Artifacts) Studio dev-loop end-to-end and nails the API method names that [`tasks/nebula-dev-flows.md`](../../tasks/nebula-dev-flows.md) references.

> **Naming note (2026-06-19):** the canonical model since flipped the shell sync from `pull()`/`getSourceTree` to **push** — DevStudio→container `applyChanges` — because Artifacts is optional/maybe-never and push is simpler (one mesh call). This experiment used `pull()`/`getSourceTree` (it proved the *harder* fetch-back direction); push is the **same mesh mechanism**, simpler, so the transport proof here still holds — only the names differ.

## Stage 1 — DevStudio source side (shell + isomorphic-git in a DO) ✅ 2026-06-19

**Question:** does `@cloudflare/shell`'s `Workspace` + isomorphic-git actually run inside a workerd Durable Object? (Everything in the design hinges on it.) **Answer: yes**, on `wrangler dev` (local, plain DO, `nodejs_compat`), first try.

`/probe` ran three edits + reads:
- `writeSource` commits each edit → **distinct oids** `5025fe…` → `04fed1…` → `aa8ba5…`; `oidsDiffer=true`.
- `readSource` returns the **latest** content (`read2IsLatest=true`).
- `head` = last oid; **`commitCount=3`** (real git history in the DO's SQL).
- `getChangedSince()` returns both files with content (`App.vue` 24 B, `main.ts` 18 B).

**Wiring (nailed — this is the real API):**
```ts
// constructor (DevStudio DO)
this.#ws  = new Workspace({ sql: ctx.storage.sql, namespace: 'src' });  // source-of-truth (interim)
this.#fs  = new WorkspaceFileSystem(this.#ws);
this.#git = createGit(this.#fs, '/');                                   // @cloudflare/shell/git
await this.#git.init({ defaultBranch: 'main' });                        // once
```

| DevStudio method | Impl | Diagram role |
|---|---|---|
| `writeSource(path, content) → {oid}` | `fs.writeFile` → `git.add` → `git.commit` | the AI edit / commit step |
| `readSource(path) → string` | `fs.readFile` | LLM local read (hot path) |
| `head() → oid` / `commitCount()` | `git.log` | rev tracking |
| `getSourceTree() → {head, files[]}` | read tracked paths (full tree) | what `DevContainer.pull()` fetches (**interim only**) |

**The Artifacts swap point is confirmed in the same API:** `createGit` exposes `remote({add:{name,url}})`, `push({remote, ref, token})`, `pull({remote, token})`. Interim uses none (local commits only); the target adds `remote`+`push` on the DevStudio side and a real `git pull` on the container side — **no call-site changes above the seam.**

Imports: `@cloudflare/shell` (Workspace, WorkspaceFileSystem) + `@cloudflare/shell/git` (createGit). Both transitively load `@cloudflare/codemode` (accepted). `compatibility_flags: ["nodejs_compat"]` required.

Notes / refinements (not blockers):
- `getSourceTree()` is **interim-only** and full-tree by design: under Artifacts the container `git pull`s the remote directly (DevStudio not in the transfer path), so incremental is never needed on the DevStudio side — Artifacts gives it for free.
- File listing is tracked in DO kv (a `paths` set) rather than walking the FS — fine for the experiment; the real one can use isomorphic-git `listFiles({ref:'HEAD'})`.
- **Checkpoint = git tag:** `createGit` has no `tag` verb — the checkpoint feature would call raw `isomorphic-git` `git.tag`/`git.annotatedTag` (isomorphic-git is a direct dep). Not exercised in Stage 1.

## Stage 2 — DevContainer.pull() cross-DO transport ✅ 2026-06-19

**Question:** does `DevContainer.pull()` reconcile the container's working tree from DevStudio — interim, with no Artifacts remote? **Answer: yes**, on local `wrangler dev` (Docker Desktop).

`/loop` ran the full interim loop: edit on DevStudio → commit → `DevContainer.pull()` → file lands in the container.
- `writeSource('src/App.vue', '<template>MARKER-3</template>')` → commit `d6d3a7…`.
- `DevContainer.pull()` — from **inside the container DO** — RPC'd `this.env.DEV_STUDIO.getByName(...).getSourceTree()`, then wrote each file via the command-server: `written: 2`, `head: d6d3a7…`.
- `readFileInContainer('src/App.vue')` → `<template>MARKER-3</template>` — **`ok: true`**, `headsMatch: true` (container HEAD == DevStudio commit).

**Confirmed:** cross-DO RPC works from a `LumenizeContainer` (`this.env` is populated); `containerFetch`→command-server `/write` lands files in the working tree. So the interim source transport is real.

**Nailed:** `DevContainer.pull() → {written, head}` (interim: RPC `DevStudio.getSourceTree()` + write; target: `git pull` the Artifacts remote — same name + call site). Container base = `LumenizeContainer`, `defaultPort` = command-server.

**Deliberately out of scope (already proven elsewhere):** vite HMR on the landed file — `container-local-dev-matrix`/phase0 showed file-write → `js-update` hot-swap (~114 ms). The full loop is therefore proven by composition: **Stage 1 (DevStudio source) + Stage 2 (pull transport) + prior (vite HMR)**.

## Stage 3 — mesh-compliant loop ✅ 2026-06-19 (fixes the Stage-1/2 rule-breaks)

Stages 1–2 took two shortcuts that broke architectural rules; **Stage 3 fixed both and passed.**
- ❌→✅ **Raw Workers RPC → mesh.** `pull()` now reaches DevStudio via `this.lmz.callRaw('DEV_STUDIO', INSTANCE, this.ctn<DevStudio>().getSourceTree())` — real mesh, not `env.X.getByName().method()` (ADR-007 / mesh.md Nebula-never-raw).
- ❌→✅ **Plain DO → Nebula node.** DevStudio now `extends LumenizeDO` with `@mesh` methods (`writeSource`, `getSourceTree`). DevContainer is a `LumenizeContainer` with `@mesh pull()`/`healthz()`/`readFileInContainer()`. The worker drives both through the mesh receive seam (`__executeOperation` + preprocessed envelopes), never raw method RPC.

**`/loop` result:** edit committed (`4ee8fca…`) → `pull()` (mesh `callRaw` → write) → `{written: 2, head: 4ee8fca…}`, **`headsMatch: true`**, landed `<template>MARKER-8eaa97ff</template>` → **`ok: true`**. **No polling** — `pull()` returns its result, so the caller gets completion as the response (the prod requirement). callRaw is used only for the single inline `getSourceTree` hop ("transport, not architecture" per ADR-003); cross-node *completion* back to DevStudio in prod is a one-way completion continuation (not a blocking round-trip, not polling).

**Confirmed under local `wrangler dev` (Docker Desktop):** a `LumenizeContainer` makes an OUTGOING mesh call to a `LumenizeDO` and uses the returned value — DO↔DO needs no Gateway/JWT (identity self-stamps from the inbound envelope). The only accepted/constrained rule-break remains the *future* Artifacts `git pull` (raw HTTPS egress, single allow-listed host).

**Incremental `getChangedSince(rev)` — why we're staying full-tree:** a true git *tree-diff* (rev↔HEAD) needs `isomorphic-git` `walk`, which needs an fs adapter shell's `createGit` keeps internal (not exposed). Options: (a) full-tree [simplest; fine — dev apps are small]; (b) `git.log` + a per-commit changed-paths side-record [pragmatic incremental, bespoke]; (c) **adopt Artifacts** — `git pull` is *natively* incremental. So incremental-done-right IS the Artifacts payoff; doing it by hand is bespoke effort for a negligible gain on dev-sized apps. **Staying full-tree on the shell path.**

## End-to-end verdict
The **entire interim (pre-Artifacts) design is proven** and the API is nailed. The Artifacts swap is isolated to two method bodies (`DevStudio` push to a remote; `DevContainer.pull()` → `git pull`) behind unchanged call sites — `createGit` already exposes `remote()`/`push()`/`pull()`. Remaining for a production DevContainer image: add git + vite (the target needs git for the Artifacts pull; vite for HMR) — both already proven in the other container experiments.
