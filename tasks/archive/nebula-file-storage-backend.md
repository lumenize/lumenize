# Nebula File-Storage Backend

**Status**: On-hold (deferred post-demo, split out of `tasks/nebula-studio.md` 2026-06-16).

**Demo decision (in effect now):** application source files are `file` resources on the dev Star, and the durable draft source-of-truth is the **Galaxy** behind a **backend-agnostic save API the Galaxy owns** — demo backend is **Galaxy SQLite**. See `tasks/nebula-studio.md` § *Files as resources* and § *Durable draft ownership* for the live design. This file holds the **post-demo investigation** into what storage product backs that API (and the built-artifact bundle store), so the swap is a `StateBackend` change, not an API change.

## The question

Originally framed as "DO SQL vs Artifacts for file resources." Reframed 2026-06-04 to: **do we adopt `@cloudflare/shell`'s `Workspace` API as the backend for our file resources (and built bundles)?** Adopting `Workspace` gets a filesystem + working git layer on DO SQL + R2 today; the Artifacts question then reduces to "swap to the Artifacts-backed `StateBackend` when it ships" — a much smaller decision than picking a new storage product.

## `@cloudflare/shell` findings (`@cloudflare/shell@0.3.8`, 2026-06-04)

- Built on **Durable Objects + R2** (not Containers, not Artifacts). Its `Workspace` class is a filesystem on DO synchronous SQL — single table `cf_workspace_<namespace>` with `path` (PK), `parent_path`, `type` (file/dir/symlink), `mime_type`, `size`, inline `content` OR `r2_key` over a configurable threshold. Symlinks supported.
- Runtime-neutral `StateBackend` interface, two impls today: `InMemoryFs` (ephemeral) + `WorkspaceFileSystem` (durable, DO SQL + R2). The forthcoming Artifacts integration is almost certainly a third `StateBackend` behind the same API — FS surface stays, storage swaps underneath.
- `@cloudflare/shell/git` is `isomorphic-git` reading/writing through that `FileSystem`. Real `git.clone({url})` / `git.commit` / `git.push({token})` over HTTPS to real remotes (GitHub etc.). MIT-licensed.
- Background: Aron (Cloudflare Discord) flagged a content API for Artifacts on the roadmap + a new `@cloudflare/shell` iteration with Artifacts support expected in preview ~a week out (as of 2026-06-04). Larry asked about beta access. Marked Experimental at 0.3.x.

## What it unlocks: enterprise BYO-agent

Power users / enterprises required to use their own agentic coding agents (Claude Code, Cursor, etc.) will expect a real git + filesystem surface, not Studio's checkpoint metaphor. Worked example: an enterprise on GitHub Enterprise + Claude Code installs a webhook (or our GitHub Action) on push-to-`main` → Nebula `git.clone({url})` into a build-DO's `Workspace` → the build pipeline operates via the `state.*` FS API → pushes the built bundle to Galaxy for lazy deploy to Stars. This could run today on `WorkspaceFileSystem` (DO SQL + R2) — no Artifacts dependency. (This is also the strongest argument for a post-demo desktop authoring shell — see `tasks/nebula-studio.md` § *Authoring environment* "Post-demo directions".)

## Built-artifact (compiled UI bundle) storage

Serving the compiled bundle is a Galaxy/Star-hosted web-server-like interface either way (MIME types, CSP, routing); the open question is the storage layer behind it. Candidates: Galaxy SQLite, Workers KV, R2, a `@cloudflare/shell` `Workspace` (DO SQL + optional R2), or an Artifacts-backed `StateBackend` once the content API ships. **Decide this jointly with the file-resource backend** — picking `Workspace` for *both* lets the whole pipeline (source files + built bundles) share one storage abstraction, and the eventual Artifacts swap applies uniformly. Keep Galaxy's version-management API backend-agnostic so the choice stays deferrable.

## Re-litigate the old "WASM git is heavy" claim

The earlier rejection of a git-on-DO layer targeted a *hand-rolled* WASM git (multi-MB, slow in Workers). Now that Cloudflare ships an official `isomorphic-git`-on-DO impl with auth injection and a proper FS layer, the relevant question is how *that bundle* performs inside our DO budget. Probably YAGNI for the demo, but worth a focused evaluation once the package stabilizes — before we lock in our own file-resource backend design.

## Revive when

A real need for git/FS surface, large built-bundle storage, or enterprise BYO-agent lands — or when the Artifacts content API + `@cloudflare/shell` Artifacts backend reach preview.
