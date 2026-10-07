# Mesh 1.0.0-alpha.1

**Status:** a holding file, like `backlog.md` and [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md), for what must be done or decided before `@lumenize/mesh` 1.0.0-alpha.1 is published. Not a build commitment as a whole: each item becomes a task file of its own, or joins one, when it starts. Work starts after [mesh-is-built-on-the-scope-tree.md](mesh-is-built-on-the-scope-tree.md) lands and Nebula pre-alpha ships, and the npm publish in [nebula-pre-alpha.md](nebula-pre-alpha.md)'s close-out waits for it.

## Objective

**An adopter can install `@lumenize/mesh`, read its docs, and run a multi-tenant app on it without anything from Nebula.**

After `mesh-is-built-on-the-scope-tree.md`, Nebula runs on Mesh 1.0, but an adopter on their own would find routes with no pages, website docs describing 0.26, and labels that only fit an app builder. The items below close that gap. Items 1 to 4 must land, Item 5 must be decided, and Item 6 is a candidate.

## Item 1: The website docs rewrite

**Goal:** `website/docs` describes Mesh 1.0, and the `@check-example` checker covers every page again.

- **What it rewrites:** `docs/mesh`, `docs/auth`, `docs/debug/index.mdx`, and the package table in `docs/introduction.md`, which still lists `@lumenize/auth` as current and `@lumenize/rpc` as the foundation of `@lumenize/testing`.
- **What it removes:** the checker exclusion `mesh-is-built-on-the-scope-tree.md`'s D8 adds to `website/scripts/check-examples.mjs` and `website/docusaurus.config.ts`, labelled `TEMP → target: the Mesh 1.0-alpha docs rewrite`. The run passes with it gone.
- **It draws on § *Docs ideas*,** the running list at the end of this file.
- **What it teaches that 0.26 did not:** scoped and unscoped nodes, with `ScopedMeshDO` and `UnscopedMeshDO`; Mesh's `/auth` entry points; and the for-docs mini-apps' `DocumentDO` and `TeamDocDO` under scope names, since they hold a tenant's data.

## Item 2: Mesh's default auth UI

**Goal:** an adopter who supplies no pages still gets working ones.

- **Hosted pages on the platform host.** Login, magic link, signup, acceptance and consent, log out, and the Home picker. Every adopter needs them, because sessions live on the platform host (ADR-022) and no page in an adopter's app can set those cookies. They sit behind the seam `mesh-is-built-on-the-scope-tree.md`'s D17 adds, so an app that supplies its own, as Nebula does with Studio's, keeps them.
- **An avatar-menu component for scoped pages.** Switch scope, pending invites, my profile, and log out, using `MeshClient`'s session. Home offers the same actions for a tab no page sent; Studio's avatar menu already opens *My profile*.
- **Open: what the component is built in.** Nebula is Vue, and an adopter may not be. Vue's `defineCustomElement` is one way to ship one component to both.
- **Open: theming.** Under ADR-020 a surface declares one theme, so an adopter's brand reaches these pages as configuration.

## Item 3: Tier labels and tier count

**Goal:** an adopter can name the tiers for what their app is, and use fewer of them.

- **Decided:** Universe, Galaxy and Star, with `universeGalaxyStarId`, stay Mesh's names in code (`mesh-is-built-on-the-scope-tree.md` D18). What never varies is the guarantee: lateral movement is refused by construction.
- **Open: the labels people see.** Nebula's copy says Account, App and Tenant. "App" only fits an adopter who builds apps; a more common shape is an umbrella account whose second tier is a billing unit within it. How an adopter sets the labels is open, environment variables being one candidate.
- **Open: fewer tiers.** Some adopters will ignore the lowest tier and run two. Whether that already works by never creating a Star, or needs Mesh to say so, is for this item to check.
- **Starts with an audit** of where Account, App and Tenant appear in copy, in Nebula and in Mesh's default UI.

## Item 4: The npm deprecations

**Goal:** a user of a retired package is told what replaces it.

- `@lumenize/auth`, pointing at `@lumenize/mesh/auth`; its source left the repo in `mesh-is-built-on-the-scope-tree.md` (D9).
- `@lumenize/fetch`, which nobody runs in production; its suites are skipped, never deleted, in case streaming revives it.
- Larry runs `npm deprecate`, or says to. Checked by `npm view @lumenize/auth deprecated` and `npm view @lumenize/fetch deprecated`, each naming what replaces it.

## Item 5: The version and the dist-tag

**Goal:** the publish puts 1.0.0-alpha.1 where an adopter expects it, and moves no other package by accident.

- **Lerna is in fixed mode**, at 0.26.0 in `lerna.json`, so moving Mesh to 1.0.0-alpha moves every public package with it.
- **`scripts/release.sh` runs `lerna publish from-package` with no dist-tag**, so 1.0.0-alpha.1 becomes `latest` unless this decides otherwise. The script's post-publish check reads `dist-tags.latest`, so an `alpha` tag would change it too.

## Item 6: Candidate — the Registry as a mesh node

**Not an obligation for the publish.** `mesh-is-built-on-the-scope-tree.md`'s D13 keeps the Registry raw and makes this a follow-on, which waits for the relay to refuse a binding no Client may name. It would remove the facade's raw stub and the `claims` argument passed by hand into `issueInvites`, `createGalaxy`, `expandScope` and the deletion calls. The facade stays a Worker either way, since invite emails, impersonation tokens and a deletion's fan-out run there to keep work off the singleton (ADR-018).

## Docs ideas

A running list of examples and explanations worth a place in the Mesh 1.0 docs, added as they come up. Item 1 draws on it.

- **A Client that adds its own incoming calls, layer on layer** (from `mesh-is-built-on-the-scope-tree.md` D6 and D20). `MeshClient` carries the session; `NebulaClient` extends it, composes a Resources part, and declares the five push methods the server calls, each a top-level `@mesh()` method forwarding to the part; `StudioClient` extends that and adds `@mesh() handlePreviewReady`, which the Galaxy pushes when a build is ready. It shows an adopter where a Client's incoming calls live, and why the class the server pushes to sits in the package the server can import.
- **Scoped and unscoped nodes, with `Profile` as the unscoped example** (D7, D14). A Star `acme.crm.tenant1` is guarded by passage; a `Profile`, named by its `profileId`, admits every caller and lets each method decide, its public reads open and its writes checking owner-or-admin.
- **An adopter's per-document node, guarded by a `@mesh()` guard** (D7's rejected alternatives). One `DocumentDO` per document holds a tenant's data under an unscoped name, and a guard on each method checks passage into the tenant it belongs to.
- **Two conventions for a composed capability.** On a server node, one `@mesh()` getter gates the part and callers chain through it, `ctn<Star>().resources.transaction(…)`; on a Client, the incoming calls are top-level `@mesh()` methods (D6).
