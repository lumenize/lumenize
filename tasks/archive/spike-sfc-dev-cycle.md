# Spike: SFC dev-cycle (originally "SFC + Galaxy dev-cycle")

**Status**: ✅ **COMPLETE** (2026-05-15). All four phases passed. See [apps/nebula/spike/sfc-devstar-loop/RESULTS.md](../apps/nebula/spike/sfc-devstar-loop/RESULTS.md) for findings. Parent task: [tasks/nebula-frontend.md](nebula-frontend.md) § Phase 5.3.7-v1 (resumes against SFC authoring per spike's recommendation).

**Outcome — short version**: SFC authoring is viable. `@vue/compiler-sfc` runs cleanly in Workers, the end-to-end loop works, and round-trip latency is ~36 ms p50 deployed (Pittsburgh→IAD) — well inside the "feels instant" target. **One architectural correction landed during the spike: the compile DO is the user-local dev Star (per `tasks/nebula-branches.md`), NOT the regional Galaxy.** Galaxy stays out of the per-save critical path; the per-save loop runs entirely inside the user-local `.dev` branch's Star.

**Delete-after-port**: when [tasks/nebula-studio.md](nebula-studio.md) § Editor / Preview is implemented (dev-Star compile + reload), port the spike's code (~250 LOC across `galaxy.ts` + `index.ts` + the WS hibernation pattern) into the dev Star, then **delete `apps/nebula/spike/sfc-devstar-loop/` and this task file**. The spike's role ends there.

**Goal (original)**: Validate that Galaxy can host a fast SFC compile + browser-reload cycle, so Nebula Studio's authoring surface can be `.vue` SFCs (the canonical Vue authoring format) rather than template strings stuffed inside JS. *Revised during the spike: compile lives on the dev Star, not Galaxy. The validation transfers — same code, different host DO class.*

**Time-box**: 2 days. *Used <1 day. All four phases completed in a single sitting on 2026-05-15.*

## Why this spike

The pinned Phase 5.3.7 decision is "Vue 3 in-DOM mode with template strings," driven by the "single HTML file + `<script src>`" target — no build step required for dev iteration. That's correct given today's infrastructure, but it forces ergonomically-poor authoring patterns visible in coding-your-ui.md:

- HTML stuffed inside JS strings (the recursive `TreeNode` example, the DAG-tree worked example, the conflict-modal example).
- A kebab-case rule for component tags whose only justification is "the browser HTML parser lowercases tag names in `innerHTML`."
- A meaningful chunk of the doc explaining workarounds and constraints that don't exist in SFC authoring.

If Galaxy can compile SFCs fast enough that the LLM-author's save → preview loop feels instant (target <1 s warm), the dev experience win is large and several doc chapters get simpler.

The compile pipeline architecture sketched for Phase 5.3.7-v3 (Galaxy pre-compiles `@vue/compiler-dom` templates at deploy time) doesn't yet exist — it's planned but unbuilt. The SFC variant uses `@vue/compiler-sfc` instead of `@vue/compiler-dom` but otherwise has the same shape. This spike builds the pipeline for the first time, using the SFC compiler.

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| `@vue/compiler-sfc` runs in Workers | yes / no | **Kill criterion.** Same Workers-compat audit pattern as typia. If it doesn't run cleanly, abandon before building any infrastructure. |
| Warm SFC compile latency (Galaxy) | <100 ms p50 for a ~50-line SFC | Vue compiler is fast; should pass easily |
| Cold Galaxy invocation overhead | <300 ms p99 | DO cold-wake + module load |
| Round-trip total (save → preview reload visible) | <1 s warm, <3 s cold | What the LLM-author actually experiences |
| WS reload reliability | 100% over 50 reloads | No dropped notifications |

## Spike layout (as built)

Per CLAUDE.md "Experiments" pattern: own `package.json`, own `wrangler.jsonc`, expected to break after the spike completes, not maintained as production code.

```
apps/nebula/spike/sfc-devstar-loop/   ← renamed from sfc-galaxy-loop post-spike
├── package.json
├── wrangler.jsonc                    ← Worker name remains `spike-sfc-galaxy-loop`
│                                        (matches the deployed instance for measurement)
├── src/
│   ├── index.ts                      # default Worker fetch handler with routeDORequest
│   └── galaxy.ts                     # `SpikeGalaxy` DO (class name kept; represents
│                                        what will become the dev Star in production)
├── test/
│   ├── kill-criterion.test.ts        # @vue/compiler-sfc + TS in Workers
│   └── functional-loop.test.ts       # WS register → compile → broadcast (correctness)
├── probes/
│   └── measure-roundtrip.ts          # node.js client, measures wall-clock latency
└── RESULTS.md                        # full findings + recommendations
```

## Implementation defaults (revisit if spike surfaces concerns)

- **DO base class for spike's Galaxy**: same base class as production Galaxy (NebulaDO). Mirrors production architecture so spike findings transfer truthfully.
- **Route prefix for dev-reload WS**: `/dev/reload/:sessionId`.
- **Session identification**: `sessionId` carried in URL path; injected client receives it via a `data-session-id` attribute on a known DOM element (or hardcoded for the spike).

## Implementation sequence

1. Add a v1-pause note to [tasks/nebula-frontend.md](nebula-frontend.md): Phase 5.3.7-v1 paused 2026-05-15 pending this spike. If SFC wins, v1's pinned authoring surface gets redesigned accordingly.
2. Scaffold the spike directory (originally `apps/nebula/spike/sfc-galaxy-loop/`, renamed to `sfc-devstar-loop` post-spike): `package.json`, `wrangler.jsonc`, empty `src/` files. Add to root `package.json` workspaces.
3. **Kill-criterion check first**: minimal smoke test that imports `@vue/compiler-sfc`, compiles a representative SFC inside a DO, asserts it produces valid JS. If `@vue/compiler-sfc` hits Workers-incompat issues (node-isms in transitive deps), **abandon the spike before building infrastructure**.
4. If the kill criterion passes: build Galaxy DO (compile + WS-hibernation), Worker fetch handler with `routeDORequest`, injected client. **Surface the Worker fetch handler diff for Larry's review before applying** — entry-point routing is sharp-edge territory even in a spike.
5. Instrument the round-trip — measure each segment (save event → compile → notify → reload) — and write `RESULTS.md` with the findings against the success-criteria table.

## WebSocket refresh pattern

Standard two-step Workers → DO routing on Cloudflare:

- Worker's default `fetch` handler uses `routeDORequest` from `@lumenize/routing` to route WS-upgrade requests to Galaxy.
- Galaxy (the spike's NebulaDO) accepts the WS upgrade and holds it via Cloudflare's hibernating-WebSocket API.
- On compile complete, Galaxy broadcasts `'reload'` to the WS connection(s) keyed by `sessionId`.
- Injected client (in preview page) listens for `'reload'` messages and calls `window.location.reload()`.
- Reconnect-on-close in the injected client handles transient disconnects without manual page refresh.

## After the spike: moving this to the dev Star (NOT Galaxy)

**Architectural correction landed mid-spike (2026-05-15):** the compile DO is the user-local **dev Star** per [tasks/nebula-branches.md](nebula-branches.md), not the regional Galaxy. Reasoning:

- Galaxy is regional (one per universe.galaxy); a developer in Sydney → US Galaxy pays ~200–300 ms RTT per save. Not "feels instant."
- Dev Stars are user-local. Per nebula-branches.md, every Star auto-creates `.main` and `.dev` branches as independent DO instances; each is placed by Cloudflare in the colo of its first call. Sydney Studio → AU colo → AU dev Star. Eyeball-to-dev-Star is single-digit ms anywhere.
- Dev Star already has the NebulaClient WS connection from Studio (it's a Star — that's how Studio talks to it for everything else). Reusing that connection for compile + reload means no new WS plumbing.
- `@vue/compiler-sfc` is library code; same Worker bundle deploys to all colos, all dev Stars share the import.

Production rollout notes for the dev-Star path:

- **The dev Star is the Star DO class with a fresh branch suffix (`.dev`).** It's the SAME class as production Stars — adding compile + reload methods affects every Star but they're inert unless used. For the demo this is fine; longer-term we could subclass or feature-flag.
- **Compile arrives over NebulaClient mesh, not via path-action HTTP.** Studio's NebulaClient calls `lmz.call(STAR, '<branch-instance>', compileSFC(source))` over the existing WS. The dev Star's `@mesh()` compile method handles compile + notify. Simpler than the spike's path-action routing.
- **Reload broadcast uses the existing Subscriber/fanout machinery.** Preview clients subscribe to a special `'__reload__'` resource (or similar) on the dev Star. The compile method writes/broadcasts to that, fanout picks up the notification. No separate hibernating-WS pool needed.
- **Existing `apps/nebula/` Worker fetch handler** is already in place for NebulaGateway routing; no new entrypoint plumbing for the WS upgrade — NebulaClient ↔ Gateway already covers it. Dev mode doesn't need a `/dev` prefix because there's no separate dev-mode HTTP surface.
- **Galaxy is NOT in the per-save path.** Galaxy is only touched at session start (pulling the user's ontology bundle into the dev Star) and at deploy time (pre-compiling templates for production assets — separate concern, see [tasks/nebula-frontend.md](nebula-frontend.md) Phase 5.3.7-v3 "CSP unsafe-eval" item).
- **Phase 5.3.7-v1 resumes against SFC authoring.** The pinned "Vue 3 in-DOM mode with template strings" decision is reversed; coding-your-ui.md gets rewritten with `.vue` SFC examples.

The spike's code transfers 1:1 to the dev Star — same compiler import, same hibernating-WS pattern, just hosted in a different DO class.

## Cross-references

- Parent task (paused): [tasks/nebula-frontend.md](nebula-frontend.md) § Phase 5.3.7-v1
- Precedent spike (Alpine → Vue pivot): [tasks/archive/vue-in-dom-spike.md](archive/vue-in-dom-spike.md)
- CLAUDE.md § "Experiments" — spike package layout conventions
