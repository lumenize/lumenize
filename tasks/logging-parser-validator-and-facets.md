# Logging in ts-runtime-parser-validator & Nebula Facet Validation

**Status**: Findings captured — plan TBD (discussion pending)

> This file records what an audit on 2026-06-01 found about logging in the
> facet-validation path. It is **findings, not a plan** — the approach (what to
> log, at what level, and where) will be decided in a follow-up discussion.
> Branch where the audit ran: `claude/mesh-nebula-logging-audit-q4P5U`.

## Scope of the audit

- `packages/ts-runtime-parser-validator/src/`
- The Nebula code that *uses* the parser/validator as a per-version facet:
  - `apps/nebula/src/star.ts` (`#ensureFacet`, facet lifecycle)
  - `apps/nebula/src/resources.ts` (`transaction` → `facet.parseBatch`)

## What the facet path is

A "facet" here is a per-ontology-version `ParserValidator` Durable Object that
validates/parses resource data against a dynamically compiled schema.

- `star.ts:#ensureFacet()` loads the validator facet via
  `getParserValidatorFacet()` with a `bundleId` keyed on `${galaxyId}/${version}`,
  caches it in `#facet`, and recreates it when new ontology state is installed.
- `resources.ts:transaction()` receives the facet and calls
  `facet.parseBatch(requests)`. Results are a `Map` of
  `{ valid: true, data } | { valid: false, errors }`. Failures are collected
  into a `validationErrors` map and returned as `{ ok: false, errors }`.

## Findings — current logging state

1. **`@lumenize/ts-runtime-parser-validator` has zero logging.**
   - No `@lumenize/debug` import; no `console.*` calls anywhere in `src/`.
   - By design it **returns** validation errors as data
     (`{ valid: false, errors: [...] }`) and never throws at runtime. Only
     compile-time helpers (`extractTypeMetadata`, `generateParseModule`) throw,
     and only for invalid `@default` values / compile errors.
   - Consequence: the *only* place a decision to log can be made is the caller.

2. **Nebula's facet integration logs nothing — on success OR failure.**
   - `resources.ts` (~lines 310–326): validation failures are collected into
     `validationErrors` and returned to the client with **no server-side log**.
   - No log on the success path (no record of what was validated / which
     defaults were filled).
   - `parseBatch()` is **not** wrapped in try/catch — a facet load/RPC failure
     surfaces as a bare transaction error with no context (bundleId, ontology
     version, which resources).

3. **No logging of facet load/init in `star.ts:#ensureFacet`.**
   - No visibility into facet cache hit/miss, Worker Loader bundle creation,
     load success/failure, or timing.

## Why this matters (observability gap)

An operator cannot answer "why did this resource write get rejected?" or "which
type keeps failing validation, and on which field?" from server-side logs alone
— the information only exists in the client's error response. Facets are
compiled per ontology version, so the load/compile path is exactly where a
failure log would be most valuable.

## Candidate touch-points (NOT yet a committed plan)

- `star.ts:#ensureFacet` — facet load (bundleId, version, hit/miss) + load failure.
- `resources.ts:transaction` — batch-validation outcome (counts, sample error
  paths) + try/catch around `parseBatch` to log RPC/load failures with context.

## Open questions for the discussion

- Should the parser-validator package itself stay logging-free (errors-as-data
  is a deliberate design), and push all logging to callers? Likely yes.
- Log level for validation *failures*: `warn` (operational, filterable) vs
  `debug` (trace). Validation failure is usually client error, not a system bug
  → leans `warn`/`debug`, not `error`.
- Namespace convention to adopt in Nebula (see sibling task file — Nebula
  currently has almost no logging in `apps/nebula/src`).
- Whether to log on the success path at all, or only failures + facet load.
