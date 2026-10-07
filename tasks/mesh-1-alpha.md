# Mesh 1.0.0-alpha.1

**Status:** a holding file, like `backlog.md` and [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md), for what must be done or decided before `@lumenize/mesh` 1.0.0-alpha.1 is published. Not a build commitment as a whole: each item becomes a task file of its own, or joins one, when it starts. Work starts after [mesh-is-built-on-the-scope-tree.md](mesh-is-built-on-the-scope-tree.md) lands and Nebula pre-alpha ships, and the npm publish in [nebula-pre-alpha.md](nebula-pre-alpha.md)'s close-out waits for it.

## Objective

**An adopter can install `@lumenize/mesh`, read its docs, and run a multi-tenant app on it without anything from Nebula.**

After `mesh-is-built-on-the-scope-tree.md`, Nebula runs on Mesh 1.0, but an adopter on their own would find routes serving Nebula's pages, sockets whose claims only Nebula's Worker verifies, website docs describing 0.26, and labels that only fit an app builder. The items below close that gap. Items 5, 9 and 10 must be decided before the publish, and the rest must land. There is no Item 6: the Registry stays raw (`mesh-is-built-on-the-scope-tree.md` D13).

**No item here risks a schema change.** They are docs, configuration, and adopter-facing work Nebula does not need: adding a step that serves an adopter's login page changes what a route serves and nothing anyone stores. Anything that could need a schema change belongs in `mesh-is-built-on-the-scope-tree.md`, before the wipe (its § *What waits for mesh-1-alpha*). Every built app carries the Client's code, so an item here changes the wire, and the exports a generated app imports, only by addition.

## Item 1: The website docs rewrite

**Goal:** `website/docs` describes Mesh 1.0, and the `@check-example` checker covers every page again.

- **What it rewrites:** `docs/mesh`, `docs/auth`, `docs/debug/index.mdx`, and the package table in `docs/introduction.md`, which still lists `@lumenize/auth` as current and `@lumenize/rpc` as the foundation of `@lumenize/testing`.
- **What it removes:** the checker exclusion `mesh-is-built-on-the-scope-tree.md`'s D8 adds to `website/scripts/check-examples.mjs` and `website/docusaurus.config.ts`, labelled `TEMP → target: the Mesh 1.0-alpha docs rewrite`. The run passes with it gone.
- **It lands before Item 4 deletes `packages/auth`,** since `docs/auth` and `docs/debug/index.mdx` carry `@check-example` blocks that name its files.
- **It draws on § *Docs ideas*,** the running list at the end of this file.
- **What it teaches that 0.26 did not:** scoped and unscoped nodes, with `ScopedMeshDO` and `UnscopedMeshDO`; Mesh's `/auth` entry points; and the for-docs mini-apps' document nodes, which `mesh-is-built-on-the-scope-tree.md` ports as unscoped nodes with their own share lists.

## Item 2: Mesh's default auth UI

**Goal:** an adopter who supplies no pages still gets working ones.

- **Hosted pages on the platform host.** Login, magic link, signup, acceptance and consent, log out, and the Home picker. Every adopter needs them, because sessions live on the platform host (ADR-022) and no page in an adopter's app can set those cookies. They sit behind Item 7's seam, so an app that supplies its own, as Nebula does with Studio's, keeps them.
- **An avatar-menu component for scoped pages.** Switch scope, pending invites, my profile, and log out, using `MeshClient`'s session. Home offers the same actions for a tab no page sent; Studio's avatar menu already opens *My profile*.
- **Open: what the component is built in.** Nebula is Vue, and an adopter may not be. Vue's `defineCustomElement` is one way to ship one component to both.
- **Open: theming.** Under ADR-020 a surface declares one theme, so an adopter's brand reaches these pages as configuration.

## Item 3: Tier labels and tier count

**Goal:** an adopter can name the tiers for what their app is, and use fewer of them.

- **Decided:** Universe, Galaxy and Star, with `universeGalaxyStarId`, stay Mesh's names in code (`mesh-is-built-on-the-scope-tree.md` D18). What never varies is the guarantee: lateral movement is refused by construction.
- **Open: the labels people see.** Nebula's copy says Account, App and Tenant. "App" only fits an adopter who builds apps; a more common shape is an umbrella account whose second tier is a billing unit within it. How an adopter sets the labels is open, environment variables being one candidate. They are deployment configuration, never a value stored per scope, which would be a Registry column.
- **Open: fewer tiers.** Some adopters will ignore the lowest tier and run two. Whether that already works by never creating a Star, or needs Mesh to say so, is for this item to check.
- **Starts with an audit** of where Account, App and Tenant appear in copy, in Nebula and in Mesh's default UI.

## Item 4: The npm deprecations, and `packages/auth` leaving the repo

**Goal:** a user of a retired package is told what replaces it, and `@lumenize/auth`'s source leaves the repo.

- `@lumenize/auth`, pointing at `@lumenize/mesh/auth`.
- `@lumenize/fetch`, which nobody runs in production; its suites are skipped, never deleted, in case streaming revives it.
- Larry runs `npm deprecate`, or says to. Checked by `npm view @lumenize/auth deprecated` and `npm view @lumenize/fetch deprecated`, each naming what replaces it.
- **`packages/auth` is deleted** (`mesh-is-built-on-the-scope-tree.md` D9), after Item 1. Nothing outside it imports it by then. Its `test/e2e-email` is the only test that sends real mail through Cloudflare Email Sending, since Nebula and Mesh's browser Worker both use Resend, so it moves onto Mesh's auth with a `send_email` binding first.
- **The backlog's `## @lumenize/auth` section loses its package.** Each row moves to Mesh's auth or is deleted with it, among them the MCP OAuth row, the OIDC row, the verified-claims header row, the rotation-policy question, and *#sendEmail swallows a failed send*. `grep -nE 'packages/auth|@lumenize/auth\b' tasks/backlog.md` finds the rows outside that section too.
- **The `LUMENIZE_AUTH_*` names go with it,** from `scripts/audit-test-mode.sh` and the guidance that cites them: `grep -rnE 'LUMENIZE_AUTH_' scripts .github .claude docs/adr` then finds only dated history.

## Item 5: The version and the dist-tag

**Goal:** the publish puts 1.0.0-alpha.1 where an adopter expects it, and moves no other package by accident.

- **Lerna is in fixed mode**, at 0.26.0 in `lerna.json`, so moving Mesh to 1.0.0-alpha moves every public package with it.
- **`scripts/release.sh` runs `lerna publish from-package` with no dist-tag**, so 1.0.0-alpha.1 becomes `latest` unless this decides otherwise. The script's post-publish check reads `dist-tags.latest`, so an `alpha` tag would change it too.
- **The release notes carry every "Flag in the next release notes, as BREAKING" row in `tasks/backlog.md`,** and each row closes once carried. `/release-workflow` collects none of them today, so this item is their owner.

## Item 7: The app supplies its auth pages and its product content

**Goal:** an adopter's app shows its own pages and its own name, and Nebula's still show Nebula's (`mesh-is-built-on-the-scope-tree.md` D17 and D19).

- **Each of the six page routes serves a step the app supplies,** the way the facade subclass supplies `scopeLifecycleHooks`, and Nebula's step serves Studio's auth app (`mesh-is-built-on-the-scope-tree.md` § *What stays Nebula's*). Item 2's default sits behind the same seam.
- **Nebula's product content becomes configuration:** `POST /auth/coming-soon` and its tags, the agent's profile seed and `sub`, and the email sender's app name and `from` address. Nebula passes today's values, so nothing it shows changes.
- **Open: one configuration mechanism for all of them.**

## Item 8: Mesh verifies a Client's socket and tears down a scope itself

**Goal:** an adopter who forwards `/gateway/*` to Mesh gets the checks Nebula's Worker makes, and deleting a scope wipes its nodes without the adopter writing the loop.

- **Today Nebula's Worker does both.** `hostedUpgrade` in `apps/nebula/src/entrypoint.ts` verifies the token, refuses one whose `aud` is not the host's scope or whose `sub` does not begin the Client's id, and drops every client-sent `x-lumenize-*` header. `NebulaDO.onBeforeAccept` relies on that, since `ClientGateway.acceptUpgrade` only decodes the token. The teardown loop is the facade subclass's `scopeLifecycleHooks`, in `apps/nebula/src/scope-lifecycle-hooks.ts`.
- **Mesh takes the generic half of each,** driven by one map from tier to binding that the app configures. Nebula holds that map twice today, as `TIER_BINDING` in `entrypoint.ts` and `BINDING` in `scope-lifecycle-hooks.ts`. Ordering a certificate stays the app's hook (Item 10).
- **Proof:** a Worker built only from Mesh's exports refuses a `/gateway/` upgrade with a bad signature, and the test goes red when the verify step is skipped.

## Item 9: Safe defaults for test mode and Turnstile

**Goal:** an adopter cannot ship test mode, or a login with no bot check, by accident.

- **Test mode is one binding.** The Registry's `#isTestMode` and the facade read only `NEBULA_AUTH_TEST_MODE` (renamed `AUTH_TEST_MODE`), and in test mode `#deliverMagicLink` returns the link in the response. Nebula's guard is `scripts/audit-test-mode.sh`, which no adopter's repo runs, and `@lumenize/auth`'s second factor leaves with Item 4. One option: `/auth` refuses test mode on an `https:` origin.
- **Turnstile skips silently without its secret,** warning only under `DEBUG`, and its widget lives only in Studio's `LoginScreen.vue`. Either Item 2's default page renders the widget, or the docs say the check is off until configured.
- **Decide both before the publish,** and update the backlog's test-mode second-factor row and its Turnstile rows to match.

## Item 10: An adopter's hosts and certificates

**Goal:** an adopter knows how a Client reaches its scope's node without Nebula's certificate machine.

- **A Client reaches its host node through its page's host,** `hostFromHostname`, and under ADR-021 every Galaxy has hosts of its own, for which Nebula's `certificate.ts` orders a pack.
- **Open: a certificate hook, a Mesh default, or path routing.** `hostFromHostname: false` upgrades at `/gateway/{binding}/{instance}`, which a host node could serve with no certificate per Galaxy. Whether that mode stays, with `gatewayBindingName`, is this item's to settle. Nebula never sets either, since `NebulaClientConfig` omits both.
- **Nebula's Galaxy keeps its own certificate machine and the state it stores,** whatever Mesh offers adopters, so nothing here migrates a Galaxy.

## Docs ideas

A running list of examples and explanations worth a place in the Mesh 1.0 docs, added as they come up. Item 1 draws on it.

- **A Client that adds its own incoming calls, layer on layer** (from `mesh-is-built-on-the-scope-tree.md` D6 and D20). `MeshClient` carries the session; `NebulaClient` extends it, composes `ClientResources`, and declares the five push methods the server calls, each a top-level `@mesh()` method forwarding to it; `StudioClient` extends that and adds `@mesh() handlePreviewReady`, which the Galaxy pushes when a build is ready. It shows an adopter where a Client's incoming calls live, and why the class the server pushes to sits in the package the server can import.
- **Scoped and unscoped nodes, with `Profile` as the unscoped example** (D7, D14). A Star `acme.crm.tenant1` is guarded by passage; a `Profile`, named by its `profileId`, runs no passage check and lets each method decide, its public reads open and its writes checking owner-or-admin.
- **A document shared across organizations, as a Google Doc can be** (`mesh-is-built-on-the-scope-tree.md` § *Scoped and unscoped nodes*). One `DocumentDO` per document, named by an id, is an unscoped node. A guard on `subscribe` checks its own share list, and it checks the list again before each push, since the host receiving that push checks nothing for an unscoped sender. The page warns before a share leaves the owner's organization.
- **Two conventions for a composed capability.** On a server node, one `@mesh()` getter gates the composed `Resources` and callers chain through it, `ctn<Star>().resources.transaction(…)`; on a Client, the incoming calls are top-level `@mesh()` methods (D6).
