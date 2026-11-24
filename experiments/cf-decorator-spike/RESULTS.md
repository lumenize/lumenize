# Do `@mesh()` and `@rawRpc()` survive `cf`'s build? — RESULTS

**Yes, deployed, on 2026-11-23.** A Worker built and deployed by `cf` 1.0.0-rc.4 made a real `lmz.call` to a `@mesh()`-decorated method, chained through a `@mesh()`-decorated getter gate, and was refused on an undecorated method. Nebula's real Worker entry also builds and parses under the same Vite + `unplugin-swc` build. This was the one blocker `tasks/nebula-pre-alpha-fast-follow.md` § *Item 12* named; what is left there is cost.

## The question

`cf` builds a Worker with Vite, whose bundler, Rolldown, emits TC39 decorators verbatim and still exits 0 (oxc-project/oxc#9170, open on 2026-11-23). Every mesh entry is a decorator: `@mesh()` on a method or a getter, `@rawRpc()` on what our own code calls. If they could not survive the build, `cf` would hand the Worker to wrangler for dev and deploy, and that path ends 18 months after `cf`'s beta does.

## What ran

Versions: `cf` 1.0.0-rc.4, `@cloudflare/vite-plugin` 2.0.0-rc.4, Vite 8.3.8, `unplugin-swc` 1.5 with `@swc/core` 1.16, and `@lumenize/mesh` from this checkout.

**The spike Worker** (`src/index.ts`, `cloudflare.config.ts`, `vite.config.ts`) has two `UnscopedMeshDO`s. The Worker reaches `Caller` through `rawRpcStub`, and `Caller.start` fires three mesh calls at a `Callee`, each answered into a result handler:

| Call | What it exercises | Deployed answer |
|---|---|---|
| `ctn<Callee>().hello('spike')` | `@mesh()` on a method | `"hello, spike"` |
| `ctn<Callee>().gate.double(21)` | `@mesh()` on a getter gate, chained into a plain surface | `42` |
| `ctn<Callee>().secret()` | an undecorated method | refused: *Member 'secret' is not mesh-callable* |

`/meta` reads the decorator metadata straight off the prototypes with no call: `isMeshCallable` is true for `hello` and the `gate` getter, and false for `secret`. Dropped decorators would show either everything refused or nothing refused; the third row is the one that tells them apart from working ones.

```sh
npx cf build && node --check .cloudflare/output/v1/workers/default/bundle/index.js
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx cf deploy
node scripts/drive.mjs   # or curl /meta, /start?id=<uuid>, /results?id=<uuid>
```

**The control** (`vite.control.config.ts`) is the same build with no swc. It exits 0 and its bundle fails `node --check` on `@rawRpc() async teardownScope(…)`, with `@mesh() hello(who)` and the rest left verbatim. So the check can fail, and the swc arm passing it means something. Per the `reference-rolldown-no-tc39-decorators` memory, `node --check` is the detector, never a grep for `@mesh`, which minification renames.

**Nebula's real entry** (`nebula/`) builds `apps/nebula/src/worker.ts` through the same plugins, with a build-only `cloudflare.config.ts` that names the entry, `nodejs_compat` and the five Durable Object classes and nothing else. It builds in about 0.2 s from 263 modules, every output chunk passes `node --check`, none holds a verbatim decorator, `index.js` carries 32 of swc's `_apply_decs_2203` calls, and its exports are the Worker's whole surface (`AuthRegistry`, `Galaxy`, `Profile`, `Star`, `Universe`, `NebulaAuthFacade`, `AuthEmailSender`, `PlatformHost`, `WorkspaceProxy`). It was not deployed or booted: that needs the real bindings, vars and secrets, which is Item 12's work, not this spike's.

## Findings

- **The decorator blocker is gone, by `unplugin-swc`, the same plugin and options both UI surfaces carry.** Nothing new to maintain.
- **Keep `unplugin-swc`'s default `exclude`.** `exclude: []` sends swc through `node_modules`, where it reads each package's `tsconfig.json`, and several of isomorphic-git's dependencies ship one that extends `@ljharb/tsconfig`, which nobody installs, so Nebula's build fails. `@lumenize/*` resolves through workspace symlinks to real paths outside `node_modules`, so the default already transforms it. The spike's own `vite.config.ts` still has `exclude: []`, which was harmless there and is what deployed.
- **Nebula's bundle is about a quarter larger gzipped under Vite.** About 863 KiB gzipped across `index.js` and its chunks, against 683 KiB from `wrangler deploy --dry-run` at wrangler 4.147.0. Bytes are not startup cost (`packaging.md` § *Startup cost is work at import, not bytes*), so this is a prompt to measure `Worker Startup Time` on the first deploy, not a finding about startup.
- **`cf` does not share wrangler's login.** `cf auth whoami` answered *Not logged in* beside a live wrangler session, and offered to deploy to a temporary account instead, which was declined. The deploy ran with wrangler's own OAuth token passed in `CLOUDFLARE_API_TOKEN` (from `wrangler auth token --json`, never printed), so `cf` takes the same credential once it is handed over. Adopting `cf` needs a `cf auth login`, or a deploy token in `.dev.vars`, which has none today.
- **`cf` 1.0.0-rc.4 wants Node 24.22 or later**, and this machine runs 24.19. It warned and ran. Adopting it is therefore a Node bump too, which `packaging.md` § *Toolchain bumps* puts on its own axis before the toolchain moves.
- **`cf` prints its telemetry events** to the console on every command, by default.
- **`cf` has a wrangler path too, and it is not the one ending.** With no Vite project, `cf dev` delegates to a `cf-wrangler` executable that wrangler 4.163 and later ship, which reads `cloudflare.config.ts` and bundles with esbuild (`cloudflare/cf`, `fixtures/wrangler-bundler-project`). esbuild handles the decorators already. Not tried here; it is the fallback if the Vite path ever regresses.

## How it was installed, and what it left behind

The spike installs on its own, with its own `package-lock.json`, and is **not** in the root `workspaces`, unlike `workflow.md` § *Experiments*' default. Two reasons: another session had a deployed sweep and a local `wrangler dev` running off the root `node_modules` when it ran, and `cf` pins a `miniflare` beta (`5.20261119.0-beta`) that the root lock should not carry for a spike. `@lumenize/mesh` comes in as `file:../../packages/mesh`. `vue-vapor-autosubscribe` is the same shape.

The deployed Worker `experiment-cf-decorator-spike` waits for the periodic `experiment-*` sweep. Nebula's build was never deployed.
