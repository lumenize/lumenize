# Desktop Framework Evaluation for Lumenize/Nebula

## Context

Exploring desktop framework options for a future Lumenize/Nebula desktop story. Goal: extend the Mesh actor model to a desktop node type with capabilities (filesystem, long-running processes, local subprocess execution) that DOs and Workers can't offer, while keeping the programming model uniform across node types.

## Native WebView Frameworks Surveyed

The class of frameworks that use the OS's native WebView (vs. bundling Chromium like Electron):

| Framework | Backend Language | Notes |
|---|---|---|
| Tauri | Rust | Most mature; v2 added iOS/Android; strong security model (capability-based allowlists) |
| Wails | Go | Closest Tauri-equivalent with friendlier backend language; v3 in alpha |
| Neutralino.js | None (precompiled C++ server) | JS-only; smallest bundles (1-5MB); intentionally limited API |
| Buntralino | JS/TS via Bun | Neutralino + Bun as the "main process"; lets you stay in JS-land with a real runtime |
| Photino | C# / .NET | For Microsoft ecosystem |
| pywebview | Python | More library than framework |

## Why Buntralino Fits Lumenize

The framing that crystallized: "backend" is a misleading word here. In all of these frameworks, both halves run client-side on the user's machine. The "backend" process is just another local process — and through a Mesh lens, it's just another mesh node.

Architectural fit:
- The Bun process and the WebView are two local actors.
- LumenizeClient/NebulaClient could run in both, with the WebView↔Bun channel being indistinguishable from any other Mesh node-to-node call.
- Trust asymmetry maps onto capability-based permissions (WebView is sandboxed; Bun has full OS access).
- Local IPC has very different perf characteristics than network — transport layer should treat it as a fast path, not pessimize it with retry/queue logic that only makes sense over the wire.

## How Buntralino Actually Talks Between Halves

WebSockets over localhost — not OS-level IPC. Specifically:
- Neutralino's binary embeds a static HTTP server (serves HTML/CSS/JS to the WebView) plus a WebSocket endpoint for the native API bridge. Token-authed, not just open loopback.
- Buntralino slots Bun in as a peer connecting to that same WebSocket layer.
- Wire is `ws://127.0.0.1:<port>` with JSON messages.
- Bun process registers methods; WebView calls them via `buntralino.run('methodName', payload)` (promise-based RPC).

Implication for Lumenize transport: existing WebSocket transport abstractions should drop in cleanly. Worth considering whether to bypass Buntralino's RPC layer and let Mesh own the protocol on a raw WebSocket — avoids stacking RPC on RPC, keeps wire format uniform with Workers RPC.

(Separately, Neutralino has an unrelated concept called "extensions IPC" — a child-process mechanism for non-JS extensions. Different thing; probably not relevant.)

## Tauri vs. Buntralino — IPC Mechanism Difference

Tauri/Wails use the WebView's native host-to-script bridge (`window.webkit.messageHandlers`, `window.chrome.webview`, etc.) — in-process JS-to-native channels owned by the WebView. Nothing binds to a socket.

Common criticism of the Buntralino/Neutralino approach is **security, not performance**:
- Localhost WS server is reachable by any local process (token auth mitigates but doesn't eliminate).
- May be flagged by EDR tools or interfered with by corporate firewalls.
- For an AppSec-positioned product (Nebula → enterprise intrapreneurs), this becomes a recurring conversation in security reviews.

Counter-consideration for Lumenize specifically: a Mesh node is by design a network-addressable actor. Buntralino's "Bun process is already a server" model is closer to the Mesh mental model than Tauri's "Rust core is in-process callee" model. With Tauri, you'd have to expose the Rust core as a network endpoint to make it a proper Mesh peer — which somewhat undoes Tauri's security advantage. So the security tradeoff lands differently for Lumenize than for the median desktop app.

## Bigger architectural payoff: SQLite + capability matrix

Bun ships embedded SQLite (`bun:sqlite`) — synchronous, in-process, microseconds per query. From the perspective of code inside the actor, this is genuinely indistinguishable from DO storage. N+1 patterns are fine on both. A NebulaActor that only calls `this.storage.sql.exec(...)` would behave identically.

The framing that emerged: **Mesh is a graph of actor-shaped nodes; node types are defined by their capability set, not their runtime.** The coding model is uniform. What differs is "what this node type can do":

| Node Type | Storage | Filesystem | Long-running | Subprocesses | Global addr | Multi-tenant safe |
|---|---|---|---|---|---|---|
| LumenizeWorker / (future NebulaWorker) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Lumenize/NebulaDO | ✓ (SQLite) | ✗ | hibernates | ✗ | ✓ | ✓ |
| Lumenize/NebulaBun | ✓ (SQLite) | ✓ | ✓ | ✓ | needs proxy | runs as user |
| Lumenize/NebulaClient | OPFS/IndexedDB | ✗ | ✗ | ✗ | needs proxy | sandboxed |

This framing is stronger than "we built a desktop framework":
- Honest about differences (no hand-wavy "automatic sync" promises).
- SQLite-on-Bun becomes optional — most users want NebulaBun for filesystem + long-running, but the API for storage matches NebulaDO if they want it.
- Capability matrix becomes the documentation. One page.
- New capabilities fill in cells over time; never inventing new programming models.
- The value of the model scales with the number of node types. Two is mildly interesting; five+ is a real story.

## Things to design for upfront

- **Schema migrations across substrates.** Same migration definitions per-actor regardless of where it runs.
- **Encryption at rest** for the local case (SQLCipher or equivalent). AppSec types will ask.
- **Identity/addressing.** Local-first might want time-ordered IDs (ULID) for cheap merge even though the cloud side stuck with UUIDs. Worth re-opening that question for the local node type.
- **Backpressure and lifecycle.** DOs hibernate; Bun processes don't by default. NebulaBun needs an explicit "evict idle actor" policy.
- **Concurrency boundaries.** DOs serialize through input gates; SQLite WAL allows multiple readers + one writer. Pin down whether the actor owns a connection or shares it.
- **Routing.** NebulaBun is behind a NAT/laptop network; can't be addressed directly from elsewhere. Probably "registers with a NebulaDO that acts as reverse proxy."

## Bun + Anthropic — strategic angle (with corrections)

**Confirmed:** Anthropic acquired Bun in December 2025. Bun remains MIT-licensed and open source. Mandate is runtime/bundler/package manager/test runner — and infrastructure powering Claude Code, Claude Agent SDK, and future AI coding products.

**NOT confirmed (and probably wrong):** That Anthropic is releasing a deployment platform like Cloudflare. The pre-acquisition Oven cloud hosting plan was *cancelled* by the acquisition, not absorbed. Sumner himself wrote that the acquisition lets them "skip that chapter entirely." Anthropic also just committed $30B to Microsoft Azure — not the shape of a company about to compete with hyperscalers on hosting. As of late April 2026, no Anthropic deployment platform has been announced.

**Stronger versions of the strategic bet:**
1. *Bun becomes the default runtime for agentic systems.* Claude Code ships as a Bun executable; Agent SDK is built on it. Being native to that runtime is alignment with where the agent ecosystem is consolidating, regardless of hosting.
2. *Anthropic eventually ships agent-runtime infrastructure that isn't framed as "hosting."* Sandboxed agent execution environments, MCP-server hosting, etc. — adjacent to core thesis. Plausible but vague timeline.

Either way: investing in Bun proficiency now is sensible. The accurate framing for external conversations: "Anthropic owns the runtime that increasingly powers the agentic coding stack. NebulaBun lets us be native to that runtime, which positions us well regardless of what Anthropic ships next at the infrastructure layer." Don't claim an Anthropic-Cloudflare competitor is coming — that's not currently supported and would undermine the rest of the story if challenged.

## Risks to validate before committing to Buntralino

- **Bun memory issues in long-running processes.** Bun 1.1.13 (April 2026) shipped significant memory/GC fixes after public complaints; OpenCode's founder publicly switched away from "Bun and Tauri" to "Node and Electron" citing memory crashes and Windows problems. NebulaBun is plausibly exactly the long-running workload these reports describe. Real load test required — especially on Windows.
- **WebView fragmentation.** WebKitGTK on older Linux ≠ WebView2 on Windows 11 ≠ WKWebView on macOS. Test rendering across all three. (This is a Tauri issue too, not specific to Buntralino.)
- **Localhost port conflicts and EDR/firewall flagging.** Test in enterprise-AV environments before assuming clean install experience.
- **Buntralino project maturity.** Small team, niche framework. Bus factor is real. May want to plan for "if Buntralino stalls, can we drop in raw Neutralino + Bun ourselves?" — answer is probably yes, since the wire protocol is just WebSockets.

## Bottom line

The recommendation that emerged: Buntralino fits Lumenize/Nebula's model better than Tauri does, because the actor model rewards "Bun process is already a network-addressable peer" and penalizes "Rust core is in-process callee." The SQLite-in-Bun parallel to DO storage gives a clean capability story. The Anthropic/Bun alignment is a real but smaller hedge than initially framed.

Next step is probably a load-test/memory-stability spike on Bun specifically for long-running NebulaBun-shaped workloads on Windows, since that's the most likely failure mode based on current public reports.