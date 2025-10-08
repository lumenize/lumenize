---
title: "From Flirtation to Vows: Healing the MCP Type Fracture"
slug: from-flirtation-to-vows-healing-the-mcp-type-fracture
authors: [larry]
tags: [personal]
---

![Kids playing the broken telephone game](./broken-telephone-game.png)

# From Flirtation to Vows: Healing the MCP Type Fracture

Remember that childhood game called "broken telephone" where we lined up in a circle with our friends. Then, one person would whisper something into their neighbor's ear, and they would in turn whisper it into the next friend's ear until you completed the circle? If you were lucky, you might land beside the person you secretly liked—the tiny thrill of whispering anything into their ear. The lesson was that every translation from brain to words and back again was just a little bit lossy. Cumulatively, what came out the other end was nothing like the original message.

Software systems, and APIs in particular, are no different. Every layer of translation risk just a little bit of loss in fidelity. This is nowhere more true than in the realm of types, schemas, validation, and code generation — the same patch of cognitive quicksand occupied by TypeScript, JSON Schema, Ajv, Zod, and friends.

MCP is all about context portability: moving structured data democratically across agents, runtimes, and languages. The type/schema has to remain the same throughout the journey around the circle of friends. Tooling decisions have very real consequences for portability and correctness. So imagine my surprise when I discovered the Babel of type/schema translations running in MCP stacks today.

Somewhere between recess and real life we all learned the difference between a childhood crush and a partner you can build with. Flash is fun on the playground; fidelity gets you into adulthood. With Lumenize, I wasn’t looking for puppy love. I was looking for a commitment that would survive different runtimes, languages, and teams.

<!-- truncate -->

---

## Motivation

Lumenize is an MCP server platform, and it’s ready to pick a lifelong partner. The obvious date would be the MCP TypeScript SDK (as the Cloudflare `agents` package does). But our initial scope only needed Resources and Tools—a small, well-bounded slice that seemed straightforward to implement from the spec without the baggage of the entire MCP TypeScript SDK.

That’s when the relationship work began. Choosing how we do types, schemas, and validation wasn’t just a technical checkbox—it sets the tone for everything that crosses a boundary. MCP specifies a shared language for the wire (JSON Schema). We want to avoid codependent conversions (TS ↔ Zod ↔ JSON Schema), choose validators that can meet the in‑laws (edge runtimes without eval), and keep performance from being a first‑date surprise. This post is about how we auditioned alternatives, why we passed on some high‑maintenance options, and the simple vows we chose in the end.

## The Type/Schema/Validation Babel that MCP is Today

MCP’s types and validation story is a patchwork that varies by SDK, validation engine, and even runtime.

- Canonical source (spec): TypeScript first
  - The MCP spec defines canonical protocol types in TypeScript (schema.ts). From those, JSON Schema artifacts are generated and published for interoperability on the wire.
  - This gives TypeScript a great authoring experience, but JSON Schema becomes a derived artifact—already one translation away from the source of truth.

- TypeScript SDK (server and client): Zod + JSON Schema + Ajv
  - Authoring and validation (server):
    - Zod path: define tool input/output with Zod; the server parses/validates with Zod at runtime.
    - JSON Schema path: define tool input/output directly as JSON Schema; the server validates with Ajv at runtime (Zod not involved).
  - Wire contracts:
    - Zod path: to expose tool schemas to clients (`tools/list`), Zod is converted to JSON Schema (Zod → JSON Schema step in the path).
    - JSON Schema path: schemas are used as‑is; no conversion required.
  - Client/runtime validation: clients JIT‑compile Ajv validators at runtime from the received JSON Schemas. In constrained runtimes that forbid eval (e.g., some edge environments), the SDK takes an edge‑safe fallback path; otherwise Ajv codegen is used. Even assuming the edge-safe fallback is consistent, Ajv takes a big performance hit the first time a schema is validated.

- Elicitation is a special case: defined directly in JSON Schema
  - Elicitation needed semantics that JSON Schema supports cleanly but TypeScript types do not (for example, the restricted primitives-only shape, defaults, and UI-ready constraints). So this part of the spec is authored directly in JSON Schema—not in TS types.
  - Result: the spec now has mixed authorship. Some parts originate in TS, others in JSON Schema. SDKs must reconcile both.
  - Elicitation payloads are validated with Ajv (regardless of whether tools were authored with Zod or JSON Schema). Clients also validate elicitation using Ajv-compiled validators.
  - Why it’s a special case: elicitation uses a restricted subset of JSON Schema (primitives only), has opinionated defaults and enum handling, and must be robust across diverse runtimes. This introduces extra surface area and coordination overhead.

Practical complexity: two validation engines often coexist in JS runtimes—Zod for Zod-authored tools, and Ajv for JSON Schema and elicitation—which can complicate bundling and constrained environments (see Receipts for examples). Interpreter validators (e.g., TypeBox Value) can help when codegen is disallowed.

All of the mess described above is for the TypeScript SDK. It gets even messier when you consider other SDKs.

- Other SDKs and ecosystems: choose-your-own source-of-truth
  - Some key off JSON Schema directly (treating the published schema as the normative wire contract), then either generate native types from it or work dynamically without compile-time types.
  - Trade-offs:
    - Codegen from JSON Schema → native types provides dev-time safety but introduces another translation step and drift risk when schemas evolve.
    - Hand-maintained native models (redefined from docs/spec) can diverge silently.
    - Dynamic-only (validate at runtime) avoids codegen but gives up compile-time type safety and shifts errors later.

- Environmental constraints: not all validators fit everywhere
  - Ajv’s codegen performs well but can be incompatible with constrained runtimes (e.g., Cloudflare Workers without eval). Interpreter-based validation (like TypeBox Value) works broadly but has different performance characteristics.

The net effect
- We have multiple sources of truth: TS types (spec), generated JSON Schema, Zod schemas (SDK), elicitation’s direct JSON Schema, and per-language SDK models.
- Each translation—TS → JSON Schema, Zod ↔ JSON Schema, JSON Schema → native types—introduces opportunities for drift and nuanced loss.
- Different dialects (draft-07 vs 2020-12), non-standard fields (like enumNames), and format mismatches compound the problem.
- Cross-SDK behavior can diverge in subtle ways, especially around elicitation’s constrained subset and defaulting rules.

If this feels like the childhood game of “telephone,” that’s the point. MCP schemas are effectively re-stated multiple times--sometimes by automation, sometimes by humans--always with the risk of fidelity loss. See the Receipts below for links to concrete examples where this has actually caused problems. I was able to gather this list in an afternoon. I bet it just scratches the surface.

So, how do we fix this?

## TypeSpec - A Brief Flirtation

If the situation we find ourselves in feels like the [Tower of Babel](https://en.wikipedia.org/wiki/Tower_of_Babel), then TypeSpec feels like [Esperanto](https://en.wikipedia.org/wiki/Esperanto): a designed universal language promising unity across dialects.

TypeSpec (the evolution of Cadl) is seductive. One DSL to rule APIs, models, validation, client SDKs, and docs. In theory: write once, emit many. I thought I was falling in love. 

Then I realized she was high‑maintenance. Behind the spark was a list of demands: a new syntax to learn, a new compiler to run, and a whole ecosystem to care for. That isn’t unity; it’s more ceremony. TypeSpec can tidy things up inside one shop, but every doorway back to the real world (OpenAPI, JSON Schema, Zod, etc.) adds translation friction. In a world that already speaks JSON Schema, asking everyone to switch tongues risks more heartache than harmony.

I tried to let her down easy with “It’s me, not you,” but I don’t think she believed me.

---

## Zod v4: Better, but...

The MCP TypeScript SDK uses Zod. Zod is intuitive, expressive, and TS-native. As of this writing, the latest released version is still on Zod v3, but Lumenize didn't have to be. With Version 4, Zod became even more attractive in a few ways:
  - It adds native JSON Schema support via toJSONSchema() and a global registry approach. (zod.dev). 
  - Many reports cite Zod 4 being ~2x-4x times faster than Zod 3, but it's still ~4-10x slower than a compiled parser/validator.
  - Zod 4 is also reported to have a significantly smaller bundle size.

However, that doesn't change the fact that Zod was not originally designed around JSON Schema semantics, so some JSON Schema nuances are lost or approximated; for example, OpenAPI 3.0’s `nullable: true` is not the same as JSON Schema 2020-12 (which represents nullability via `type: ["string", "null"]`), and `default` never implies required—OpenAPI marks parameter presence with top-level `required: true`, while JSON Schema uses a `required: []` array on the parent object.

Bottom line, the new version makes Zod more performant, lighter, and interoperable out of the box but doesn’t completely eliminate the performance delta and it does nothing for the bundling complexity--you still need Ajv or something else for JSON Schema validation. Most importantly, it has the same subtle semantic differences with JSON Schema as the previous version.

---

:::note

<details id="receipts">
<summary><strong>Receipts: what we found (specific, linkable examples)</strong></summary>

Concrete places where starting from TS/Zod and emitting JSON Schema, or mixing dialects/validators, caused friction. These support designing wire contracts as JSON Schema first (or with TypeBox, which is JSON Schema–native).

- Non‑standard enumNames vs JSON Schema
  - Historically used `enumNames` (non-standard) for enum display labels. Fixes replace with standard patterns (for example, `oneOf` with `const`+`title`).
  - Evidence: TypeScript SDK PR “Replace non‑standard enumNames with standard oneOf” (#844)
    https://github.com/modelcontextprotocol/typescript-sdk/pull/844
  - Evidence: Spec work “Elicitation Enum Schema Improvements and Standards Compliance” (#1148 PR, #1330 issue)
    https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1148
    https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330

- Dialect mismatch (draft‑07 vs 2020‑12)
  - Clients/tools increasingly assume JSON Schema 2020‑12 while generated schema remained draft‑07 for a period, causing incompatibilities.
  - Evidence: Spec issue “Support full JSON Schema 2020‑12” (#834) and PR “Tools inputSchema & outputSchema conform to JSON Schema 2020‑12” (#881)
    https://github.com/modelcontextprotocol/modelcontextprotocol/issues/834
    https://github.com/modelcontextprotocol/modelcontextprotocol/pull/881
  - Evidence: Spec proposal “Establish JSON Schema 2020‑12 as Default Dialect for MCP” (#1613)
    https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1613
  - Evidence: TS SDK issue “MCP TypeScript SDK generates JSON Schema draft‑07…” (#745)
    https://github.com/modelcontextprotocol/typescript-sdk/issues/745

- Zod → JSON Schema conversion fidelity gaps
  - Some Zod features don’t round‑trip cleanly to JSON Schema (e.g., transforms, certain unions), leading to lost intent on the wire.
  - Evidence: TS SDK issue “Zod transform functions are lost during JSON Schema conversion, breaking union types” (#702)
    https://github.com/modelcontextprotocol/typescript-sdk/issues/702
  - Evidence: “fix: Zod to JSONSchema pipe strategies” (#962)
    https://github.com/modelcontextprotocol/typescript-sdk/pull/962

- Format/annotation mismatches
  - Incorrect or non‑standard `format` values in generated schemas and custom formats requiring out‑of‑band support (for example, `uri-template`). Spec TS uses JSDoc `@TJS-type` hints to steer generation, which can drift from normative JSON Schema.
  - Evidence: Spec PR “Fix format value for websiteUrl in draft schema.json” (#1529)
    https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1529

- Elicitation specifics: subset design and cross‑SDK differences
  - Elicitation’s `requestedSchema` is a restricted subset of JSON Schema (primitives only). Multiple iterations aligned behavior (defaults, enums, accept without content), plus runtime/env issues.
  - Evidence: Spec PR “Add default values for all primitive types in elicitation schemas” (#1035)
    https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1035
  - Evidence: Python SDK issue “inconsistent actions between python sdk and specification for Elicitation” (#1056)
    https://github.com/modelcontextprotocol/python-sdk/issues/1056
  - Evidence: TS SDK Cloudflare Workers incompatibility: “Elicitation feature fails on Cloudflare Workers due to AJV code generation (EvalError…)” (#689) and follow‑up fix PR (#1012)
    https://github.com/modelcontextprotocol/typescript-sdk/issues/689
    https://github.com/modelcontextprotocol/typescript-sdk/pull/1012

- Fresh schema/detail drift in generated outputs
  - Example: missing fields (like `_meta`) in generated JSON Schema that were expected by the TS source/spec.
  - Evidence: Spec issue (#1616)
    https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1616

Why this matters for elicitation in particular
- Elicitation already specifies JSON Schema as the lingua franca (even if restricted). Designing it as JSON Schema first, or with TypeBox (JSON Schema‑native), would have:
  - avoided non‑standard fields like `enumNames` from leaking into wire contracts;
  - made dialect and formats explicit up front;
  - simplified validator choice (e.g., interpreter validators where codegen is disallowed);
  - reduced cross‑SDK drift by anchoring to the JSON Schema document as the normative source.

</details>

:::

## Enter TypeBox

Every story needs the steady one. TypeBox was the approachable friend I’d never considered “marriage material.” Not flashy—just compatible. It speaks the language the world already uses ([JSON Schema](https://json-schema.org/)), and it lets me keep speaking TypeScript at home. No grand gestures, fewer surprises.

If TypeSpec was the high‑maintenance seductress, TypeBox is the low‑drama partner: you write in JSON Schema grammar and get precise TypeScript types back, plus runtime validation. That combination travels well across gateways, languages, and runtimes without asking teams to learn a new language—think of TypeBox as a TypeScript way to author JSON Schema, not a new dialect.

And the part that shows up on moving day? TypeBox’s Value validator. It’s lightweight, edge‑safe, and fast in interpreted mode, with an option to pre‑compile when you need near‑Ajv speed.

The moment my eyes opened: Value validates plain JSON Schema. Use TypeBox definitions when they’re available; otherwise validate with the over‑the‑wire schema. One package covers all our Lumenize paths.

No Zod. No Ajv. No compile‑time tricks. No eval. It’s edge‑safe (Cloudflare Workers, Vercel Edge), and interpreted validation is faster than Zod with optional pre‑compile when you need more—without hauling in Ajv’s bundle or first‑hit JIT cost. That mix of portability and performance was the proposal I couldn’t refuse—so I said yes.

And after saying yes, we wrote our vows—the simple commitments that keep the relationship healthy in practice.

> **Our vows: The Wire Separation of Types**
>
> - **Use TypeScript for everything that never leaves your process.**
> - **Use TypeBox for everything that crosses a process, network, or persistence boundary.**

That boundary is sacred. TypeScript’s types model what code believes about data. TypeBox’s schemas model what machines must prove about data when it crosses a boundary.
This separation keeps our internal code expressive with early type mismatch feedback, and our wire contracts stable, serializable, and enforceable.
