# Distributed CPG Security Analysis (Mesh + Nebula)

**Status**: On hold — future direction, not committed to scope/timing
**Origin**: Conversation 2026-05-24 / 2026-05-25 — pitched as a brand-defining feature for Nebula's enterprise-security positioning, built on Mesh primitives.
**Related**:
- [tasks/mesh-call-tracing-and-ids.md](../mesh-call-tracing-and-ids.md) — `callChain` observability is the V0 substrate this builds on
- [tasks/nebula-frontend.md](../nebula-frontend.md) — Studio's hosted LLM is the eventual audience for any AI-driven surface

## Opportunity

Code Property Graphs (CPGs — AST ∪ CFG ∪ PDG, queryable; Joern is the reference implementation) are the state-of-the-art representation for static security analysis. They stop at the executable boundary. SAST tools see what one binary does to data; they cannot follow data across an RPC call into the next binary. In monoliths this is fine. **In distributed systems the interesting analysis is exactly across executables** — and there is no principled way to construct those cross-binary edges today.

## Why Mesh is positioned for this

Mesh provides, by construction, the three things needed to fill the gap:

1. **Typed `@mesh()` surfaces** — every cross-DO callable is explicitly declared in source, with TypeBox schemas at the boundary. Static enumeration of "every reachable surface" is trivial.
2. **`callContext.callChain`** — runtime-witnessed evidence of which call paths actually fire. Confirms / prunes static edges.
3. **Monorepo source access** — all code on both sides of every edge is reachable to the analyzer.

That combination is structurally unavailable to Snyk Code / Semgrep / Joern-as-shipped. The cross-binary edge construction is the novel artifact.

## Brand fit

Nebula's positioning is "enterprise-grade security, on by default." "Every Mesh app gets cross-binary distributed CPG analysis as a standard feature" is a real differentiator vs. "yet another DO framework." It also extends naturally to Lumenize Mesh as a standalone offering — Mesh-the-package becomes the substrate for a security capability nobody else can replicate.

## Landscape findings (audit 2026-05-25)

| Tool | Implementation | Output | TS-aware? | Verdict |
|---|---|---|---|---|
| **Jelly** (cs-au-dk) | TypeScript | Call graph + points-to (JSON/HTML) | No — JS semantics, ignores TS types | Closest TS-native thing, but **not a CPG**; archived-ish |
| **static-pdg-js** (Aurore54F) | Python | PDG = CFG ∪ DFG ∪ AST | No | Research code, unmaintained |
| **js-callgraph** (Persper) | JavaScript | Call graph | No | Narrow; similar to Jelly |
| **js2cpg** (ShiftLeft) | Scala (parser via GraalJS) | True CPG → Joern | Partial | Subsumed by Joern's TS frontend |
| **Joern TS frontend** | TypeScript parser + Scala CPG | True CPG | Yes, via tsc | The default to build on |

Two things worth noting before picking this back up:

- **"Implemented in TS" ≠ "better for TS."** Joern's TS frontend already uses TypeScript code for the parsing layer; what's in Scala is CPG construction and Cypher-like query, which is language-agnostic. A Scala-hosted CPG with a TS-aware parser isn't structurally disadvantaged on TS quality.
- **Jelly specifically would lose Mesh's signal.** It discards TypeScript types. The whole `@mesh()` + `ctn<X>().method(...)` + TypeBox boundary scheme depends on type info to know what is reachable from what. Run Jelly on a Mesh DO and `this.lmz.call(env.STAR, id, ctn<Star>().handleX(...))` becomes "some function value points to some other function values" — the cross-binary edge is gone.

## Architectural direction (the load-bearing decision)

**Do not adopt a TS-native CPG tool.** Build on Joern's TS frontend for per-binary CPG (only one with a real query DSL + community + ongoing dev; Scala is an analysis-time dependency, not a runtime one), and add a **Mesh-aware lowering pass** as the novel artifact:

- Written in TypeScript using ts-morph / the TypeScript Compiler API
- Extracts `@mesh()` surfaces and their TypeBox schemas
- Resolves `ctn<X>()` proxy targets through the type system
- Resolves `lmz.call(BINDING, instance, ctn<X>().method(args))` to (binding → DO class → method) edges
- Emits virtual edges in a Joern-CPG-compatible format
- Result: cross-binary edges plug into a normal Joern workflow

Rough sizing: **1–2k LOC** for the lowering pass. Building a Joern competitor is not tractable; building the Mesh-aware lowering on top of Joern is.

## Tractability ladder

- **V0 — `callChain` as first-class observability.** Live distributed call graph + per-node annotations (auth check present? arg schema present? mesh-vs-fanout?). No Joern, no AI. Differentiating on its own. Substrate for V1/V2. (Closest existing task: [tasks/mesh-call-tracing-and-ids.md](../mesh-call-tracing-and-ids.md).)
- **V1 — Mesh-aware static lowering + Joern integration.** The lowering pass above. Output: a cross-binary CPG queryable via Joern's existing tooling. Static + dynamic union: static enumerates every callable surface; `callChain` confirms which compositions actually fire.
- **V2 — LLM as query generator over the cross-binary graph.** Narrow tasks only: "find auth-check inconsistencies across paths leading to sink X", "find paths where untyped argument flows past an `@mesh()` boundary." Not "look for security holes." Frame the AI layer as a query-generator for taint queries, not a freelance vulnerability hunter.

## Honest concerns to revisit when picked up

1. **TS CPG quality is the bottleneck, not the stitching.** Joern's TS frontend is weaker than its JVM/C ones. The dynamic surfaces Mesh adds (`ctn()` proxies, decorator-mediated dispatch, `@lumenize/structured-clone` post-processing on the wire) will look opaque to AST-based CPG generation unless lowered. The lowering pass is where the work is.
2. **Coverage = exploitability gap.** `callChain` stitches only paths witnessed in production. Attacker paths are unwitnessed by definition. A Mesh-aware fuzzer (TypeBox at boundaries gives schema-guided input gen) is doable but is its own multi-week subproject. Static + dynamic union is probably the right answer.
3. **AI quality is inverse to scope.** "LLM finds vulns" → vague. "LLM generates Joern-style taint queries parameterized by the auth-check pattern in this codebase, runs them across the cross-binary graph, ranks findings" → useful.

## Open questions

- Does Joern's TS frontend produce sensible CPGs on a representative Mesh DO (e.g., `apps/nebula/src/star.ts`)? Sizing the dynamic-dispatch loss before committing is the right first probe.
- What's the right schema for cross-binary edges? Extend Joern's CPG with new edge types, or maintain a side graph that references CPG node IDs? Side graph is probably less invasive.
- How do `@mesh()`-via-typed-stub patterns lower? Specifically the 4-arg `lmz.call` with result-handler continuation (`Star.#fanout` → `Star.onFanoutDelivered`) — the result handler is local but logically tied to the remote call.
- Does the V2 AI layer pay off vs. just shipping V1 + canned Joern queries? An honest comparison should be possible before committing to V2.
- Does this surface in Studio (Nebula's hosted UI), or as a Mesh-the-package CLI (`lumenize-mesh-cpg analyze`), or both?

## Conversation that produced this

2026-05-24 message (Larry): pitched the cross-binary CPG idea — Mesh's `callChain` + `@mesh()` surfaces could be used to construct a CPG that crosses executables; standard Mesh feature; AI analysis layer on top; production traffic + fuzzer for edge discovery.

2026-05-25 message (Larry): asked to find/analyze a TS-implemented CPG generator on the hypothesis "maybe better for TS than Joern." Audit produced the table above; conclusion was that no TS-native CPG generator exists at the quality level needed, and "implemented in TS" isn't a reliable proxy for "better TS support." Direction pivoted to "build Mesh-aware lowering on top of Joern's TS frontend" rather than adopt-or-fork a TS-native tool.
