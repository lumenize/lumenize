---
title: From Babel to Unity: Healing the Type Fracture
slug: from-babel-to-unity-healing-the-type-fracture
authors: [larry]
tags: [personal]
---

# From Babel to Unity: Healing the Type Fracture

The history of software is one long pendulum swing between unification and fracture. Every generation rediscovers the dream of a single type system, only to invent another dialect, another compiler, another schema tool promising to unify everything.

We’re in that moment again. You’re reading the room exactly right: TypeSpec sits in that ever-expanding Venn diagram overlap of types, schemas, validation, and code generation — the same patch of cognitive quicksand already occupied by TypeScript, JSON Schema, Zod, and friends.

From where I stand — building Lumenize to implement the Model Context Protocol (MCP) — I can’t remain neutral. I’m forced to choose. And that choice matters, because MCP is all about context portability: moving structured data democratically across agents, runtimes, and languages. Your type/design system has to survive the journey.

⸻

## The Esperanto Promise of TypeSpec

If the situation we find ourselves in feels like the [Tower of Babel](https://en.wikipedia.org/wiki/Tower_of_Babel), then TypeSpec feels like [Esperanto](https://en.wikipedia.org/wiki/Esperanto): a designed universal language promising unity across dialects — but adopting it still means learning a new language and depending on a new toolchain.

TypeSpec (the evolution of Cadl) is seductive. One DSL to rule APIs, models, validation, client SDKs, and docs. In theory: write once, emit many. In practice: you’re introducing a new syntax, a new compiler, and a new ecosystem for each team to absorb.

That’s not unification. It’s another layer. TypeSpec could centralize parts of a system internally, but it also introduces translation friction with existing tools (OpenAPI, JSON Schema, Zod, etc.). In a world that already speaks JSON Schema, asking everyone to learn a new language risks further fracture, not harmony.

⸻

## Zod in the New Era: Better, but Still Local

The MCP TypeScript SDK uses Zod. That made sense historically: Zod is intuitive, expressive, and TS-native. But in Version 4, Zod has addressed one of the big criticisms: it now supports native JSON Schema conversion via toJSONSchema() and a global registry approach. (zod.dev)

So the claim “Zod doesn’t output JSON Schema” is no longer strictly correct in v4. It can. But with caveats:
	•	The conversion is mediated by Zod’s internal representation, so some JSON Schema nuances may be lost or approximated.
	•	Not all JSON Schema consumers will accept the output exactly as intended.
	•	The conversion makes Zod more interoperable but doesn’t eliminate the performance or bundling differences.
	•	Cross-ecosystem “false friends” still exist. For example: OpenAPI 3.0’s `nullable: true` is not the same as JSON Schema 2020-12, which represents nullability via a union type (e.g., `type: ["string", "null"]`). And `default` never implies required—OpenAPI marks parameter presence with a top-level `required: true`, while JSON Schema uses a `required: []` array on the parent object to enforce presence.

Regarding speed, many reports cite Zod 4 being several times faster than Zod 3 (e.g. ~2–4×). Some combinator-heavy usage shows regressions in performance when schemas are deeply nested or use .extend(), .omit(). (icantevencode.com)

⸻

## Why TypeBox Still Holds the Practical Edge

TypeBox doesn’t lobby for replacing everything. It leans into what’s already real: TypeScript ecosystems, JSON Schema infrastructure, and the necessity of runtime validation.

If TypeSpec is Esperanto, then [JSON Schema](https://json-schema.org/) is English—the [lingua franca](https://en.wikipedia.org/wiki/Lingua_franca) of APIs today. TypeBox is English with a great style guide: you speak JSON Schema on the wire, and you get precise TypeScript types in-process. That combination travels well across gateways, languages, and runtimes without asking teams to learn a new language.

TypeBox Value works on plain JSON Schema

The revelation that makes an architecture simpler: TypeBox’s Value validator can accept arbitrary JSON Schema — you don’t need to define a TypeBox schema object. It just expects a schema object that aligns with the kinds of constructs it supports.

For example:

```TypeScript
import { Value } from '@sinclair/typebox/value'

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number', minimum: 0 }
  },
  required: ['name', 'age'],
  additionalProperties: false
}

Value.Check(schema, { name: 'Larry', age: 42 })  // → true
```

No Ajv. No compile-time tricks. No eval. This works in Cloudflare Workers, Vercel Edge, or any sandboxed JS runtime. That means fewer moving parts, smaller downloads, and lower operational complexity.

When tested under repeated validation workloads, TypeBox’s compiled paths show dramatic multipliers over naive validation — especially vs Zod 3 or interpretive Zod 4. The exact numbers vary by environment, but the architectural headroom is real.

### The Rule of Wire Separation for Types

In Lumenize we practice a principle we call:

> **The Wire Separation of Types**
>
> - **Use TypeScript for everything that never leaves your process.**
> - **Use TypeBox for everything that crosses a process, network, or persistence boundary.**

That boundary is sacred. TypeScript’s types model what code believes about data. TypeBox’s schemas model what machines must prove about data when it crosses that boundary.
This separation keeps your internal code flexible and expressive, and your wire contracts stable, serializable, and enforceable

⸻

## Visual: Four paths to types and validation

### 1) Zod v4 + TypeScript

```mermaid
flowchart LR
  Dev[Developer] --> Zod[Zod v4 Schemas]
  Zod -- infer --> TS[TypeScript types]
  Data[Runtime data] -->|z.parse() / z.safeParse()| Zod --> Valid[Validated data]
  Zod -- toJSONSchema() --> JSchema[JSON Schema]
  JSchema -. potential gaps/caveats .-> Eco[External tooling (codegen, docs)]
  JSchema --> MCP[MCP (tools/clients)]
```

- Strengths: TS-native ergonomics, expressive combinators, great DX. Now exports JSON Schema in v4.
- Caveats: JSON Schema export may not be 1:1 with every consumer; performance varies by shape/depth.
- MCP: Can consume JSON Schema produced from Zod v4 for tool/contract definitions.

### 2) Zod v4 + TypeScript + Ajv

```mermaid
flowchart LR
  Dev[Developer] --> Zod[Zod v4 Schemas]
  Zod -- infer --> TS[TypeScript types]
  Zod -- toJSONSchema() --> JSchema[JSON Schema]
  JSchema --> AJV[Ajv compile()]
  JSchema --> MCP[MCP (tools/clients)]
  Data[Runtime data] --> AJV --> Valid[Validated data]
```

- Why: Use Ajv for high-performance/runtime-standard JSON Schema validation while authoring in Zod.
- Trade-offs: Two-step pipeline (Zod → JSON Schema → Ajv). Keep an eye on conversion fidelity and bundle size.
- MCP: Consumes the JSON Schema branch for interoperable tool definitions and contracts.

### 3) TypeBox + TypeScript + TypeBox Value

```mermaid
flowchart LR
  Dev[Developer] --> TB[TypeBox Schema (JSON Schema)]
  TB -- Static<TSchema> --> TS[TypeScript types]
  Data[Runtime data] -->|Value.Check(schema)| VAL[TypeBox Value validator]
  TB --> Eco[JSON Schema ecosystem (OpenAPI, codegen, docs)]
  TB --> MCP[MCP (tools/clients)]
  TB -. optional .-> AJV[Ajv compile()] -. optional .-> VAL2[Validated (Ajv path)]
```

- Strengths: Schemas are native JSON Schema; zero new DSL. TypeBox Value validates plain JSON Schema (no eval, edge-friendly). Static<TSchema> gives types.
- Options: Ajv remains available when you want JIT-compiled validators; Value works great in sandboxed/edge runtimes.

### 4) TypeSpec + Emitters (OpenAPI / JSON Schema / Protobuf) + Validators/Codegen

```mermaid
flowchart LR
  Dev[Developer] --> TSpec[TypeSpec DSL (.tsp)]
  TSpec --> OAS[OpenAPI 3.x (emitter)]
  TSpec --> JSchema[JSON Schema (emitter)]
  TSpec --> Proto[Protobuf (emitter)]
  OAS --> Tooling[Gateways, client/server codegen, docs]
  OAS -. component schemas .-> MCP[MCP (tools/clients)]
  JSchema --> AJV[Ajv / JSON Schema validators]
  JSchema --> MCP
  Proto --> GRPC[gRPC stubs]
```

- Strengths: Single-source API design with multi-protocol emitters; strong editor tooling and linting.
- Considerations: Adds a DSL and compile step; runtime validation and type generation depend on emitted artifacts and downstream tools.

## Choosing Fewer Fractures Over False Unity

You don’t need another “Type Babel” in your stack. You need pragmatic boundaries. You need composability across languages, runtimes, and services. You need portability.

TypeSpec promises a new world. Zod 4 makes progress toward compatibility. But TypeBox today offers something that actually works in the messy, multi-tenant reality we already live in:
	•	It lives in TypeScript.
	•	It emits JSON Schema natively.
	•	Its Value engine can validate plain JSON Schema directly, no extra plumbing.
	•	It gives you performance headroom, especially in compiled/AOT modes.
	•	It aligns with the Rule of Wire Separation.

That’s why Lumenize is built around it. We don’t demand you throw away everything. We just demand coherence: that code and schema speak the same language on both sides of the wire.