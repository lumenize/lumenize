# Typia Validator Engine (Dual-Engine Detour)

**Status (2026-05-05)**: **Superseded.** Typia adoption shipped via the typia-only `@lumenize/ts-runtime-parser-validator` package (release coordinated via `tasks/archive/parse-validate-release.md`). Remaining typia-related thread is the upstream PR work tracked in `tasks/typia-visit-tracking.md`.

**Status (original archive)**: Archived — split into `tasks/archive/nebula-5.2.4.1-validator-engine-upgrade.md` (standalone) and `tasks/archive/nebula-5.2.4.2-validator-galaxy-integration.md` (Nebula integration)
**Depends on**: 5.2.3 (ontology wiring complete), 5.2.4 (docs shipped)
**Precedes**: 5.2.5 (multi-resource queries)
**Package**: `packages/ts-runtime-validator/` + `apps/nebula/` (Galaxy)

## Objective

Add **typia** as a second validation engine alongside the existing tsc-at-runtime engine. Typia compiles TypeScript interfaces into plain-JS validators via a codegen CLI; we run that compilation inside a Galaxy-owned Dynamic Worker and invoke it from Stars. Keeps tsc-at-runtime as the zero-config default; typia becomes the fast path for write-heavy production use.

Why a detour now and not later: the public API surface is the **JSDoc tag vocabulary** users write on their interfaces. Once users have typed `@min 13` in their code, renaming to typia's `@minimum 13` is a breaking change propagated across every user's codebase. Aligning conventions now while user count is effectively zero is cheap; aligning later is a migration. Rather than just renaming tags and deferring the implementation, we implement the full engine now because we expect more semantic/syntactic mismatches to surface during implementation that we'd otherwise miss.

## Design Decisions (from design conversation 2026-04-15)

1. **Dual engine, not replacement.** Keep tsc-at-runtime as the default; add typia as an opt-in fast path. Preserves the zero-build-step story for vibe coders and for dev mode.

2. **Separation of concerns.** Typia is a pure shape-checker. Our existing `extractTypeMetadata()` remains authoritative for defaults, ORM relationships, and conventions. Typia never coerces, prunes, or fills — strict assert mode only.

3. **Galaxy owns the DW registry.** Pre-generation happens when the Galaxy accepts an app-definition update. Compilation failure → update rejected at submit time, not at first request. The Galaxy's existing ontology-version promotion mechanism extends naturally to cover DW lifecycle.

4. **Hash-keyed Dynamic Workers** — named by hash of the TS source. Promotion of a new app-version is gated on successful DW compilation. GC by refcount of "Stars currently on version N."

5. **Push-based propagation.** Galaxy pushes "new version live" to connected Stars via `@mesh`. TTL-polling fallback for Stars that weren't connected at promotion.

6. **Eager version switch, complete-then-switch for in-flight.** Stars switch to new version as soon as they learn about it. In-flight transactions finish on the old version; the next call uses the new one. Browser clients lockstep-refresh (accepted UX trade for simplicity).

7. **Tag vocabulary = public API.** The JSDoc tag names users write are the long-lived contract. Align with typia's conventions now (see Phase 1).

8. **`@default` lives in our extractor/filler, not typia.** Typia's `@default` is metadata only; `typia.assert()` does not fill missing fields. We pre-fill before handing data to typia.

## Phase 1: Tag Vocabulary Alignment

**Goal**: Nail down the JSDoc tag contract independently of which engine executes it. Do this first so subsequent phases don't churn on renames.

**Work**:
- Pull typia's full JSDoc tag list (`@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum`, `@multipleOf`, `@minLength`, `@maxLength`, `@minItems`, `@maxItems`, `@uniqueItems`, `@pattern`, `@format`, `@contentMediaType`, `@default`, etc.) — pin to a specific typia version and record it here
- Diff against every tag currently recognized by `extractTypeMetadata()` and its callers
- Rename collisions in our implementation, source comments, and docs
- Keep aliases for any tag already shipped to users so we don't break them; mark aliases deprecated with a console warning and removal milestone
- Pin value-format conventions: bare numeric values (`@minimum 13` not `@min: 13`), JSON-literal form for `@default` so typia can parse it later
- Document the tag vocabulary as the public API surface of `@lumenize/ts-runtime-validator`, engine-independent, in the existing api-reference page

**Success Criteria**:
- [ ] Complete tag table published in `/website/docs/ts-runtime-validator/api-reference.mdx`
- [ ] All source/test/docs references use aligned names
- [ ] Aliases emit deprecation warnings with a clear migration message
- [ ] Typia version pinned in this task file and in package docs

## Phase 2: `@default` Semantic Resolution

**Goal**: Pin the four `@default` axes so the engine work in Phase 3 has no ambiguity.

**Decisions to record in this file**:
- **Fill semantics**: filler runs pre-validation in our extractor; validator sees already-filled objects
- **Required vs optional convention**: fields with `@default` **must be declared optional** (`age?: number`). Extractor warns if `@default` is present on a required field.
- **Read vs write path**: filler invoked only on write path (insert/update), never on read
- **Depth**: decide whether `@default` recurses into nested objects/array elements. Write test cases pinning the chosen semantic.

**Success Criteria**:
- [ ] Design decisions documented in this file and in the validator docs
- [ ] Test cases cover all four axes including the depth decision
- [ ] Extractor emits warning when `@default` appears on a required field

## Phase 3: Typia Engine Implementation

**Goal**: Working typia-backed validator as a second engine behind the same public interface as the tsc engine.

**Work**:
- Engine selection interface: `LUMENIZE_VALIDATOR_ENGINE=tsc|typia|auto` (default `auto`; `auto` means tsc in dev, typia in prod via Galaxy)
- Typia codegen invocation — feed TS source, produce plain JS validator, package into a DW payload
- Runtime shim inside the DW that accepts validation requests over the Service Binding surface already established in 5.2.6
- Adapter in `@lumenize/ts-runtime-validator` so callers don't know which engine is running
- Dual-engine test suite: every validation test runs against both engines, asserts equivalent pass/fail and error messages (error message text will diverge — test for equivalence of outcome, not byte-for-byte match)

**Success Criteria**:
- [ ] Typia engine produces correct accept/reject for every existing validate test
- [ ] Error messages legible and reference the same property paths as tsc engine
- [ ] Bundle size and latency measured and documented

## Phase 4: Galaxy-as-Registry Architecture

**Goal**: Wire DW lifecycle into the Galaxy's existing ontology-version promotion.

**Work**:
- Galaxy accepts new app-definition → compile typia validator → provision DW → promote version atomically
- Submit-time rejection on compilation failure (surface typia's error to the caller)
- Hash-keyed DW naming
- Push notification to connected Stars via `@mesh` on promotion
- TTL-bounded pull fallback for disconnected Stars
- Refcount-based GC: Star reports current version on each call; when refcount for a non-live version hits zero, Galaxy drops the DW
- In-flight policy: Star completes current call on old version, switches on next call

**Success Criteria**:
- [ ] Galaxy rejects bad app definitions at submit time with typia's error
- [ ] Two Stars on different versions can run concurrently during a migration window
- [ ] Old DWs GC'd once no Star references them
- [ ] Version switch latency measured end-to-end (promotion → Star observes new version)

## Phase 5: Dev-Mode Engine Selection

**Goal**: Dev loop doesn't provision Dynamic Workers on every interface edit.

**Work**:
- In dev mode, engine selection defaults to `tsc` regardless of `auto`
- CLI (`lumenize` — see note below) exposes an override for devs who want to test the typia path locally

**Success Criteria**:
- [ ] `wrangler dev` / local CLI never provisions DWs unless explicitly opted into
- [ ] Prod default remains typia-via-DW

## Documentation

- Update validator package docs with dual-engine architecture and engine-selection guidance
- New blog post covering the typia engine launch — supersedes the dropped Substack/Medium cross-posts from 5.2.4
- Architectural note on Galaxy-as-registry (this file + validator docs cross-link)

## Notes

- **CLI naming**: `lmz` was rejected by npm. Using `lumenize` (already owned by a decade-old unrelated package). Accept the minor SEO confusion.
- **Security framing**: Dynamic Worker sandboxing is the security boundary; typia compiling at schema-registration time (not per-request) is a bonus, not the primary defense.
- **Dev-mode branching** is a separate task — see `tasks/dev-mode-branching.md`. Related but sequenced after this detour completes.

## Open Questions

- Typia's handling of our custom types declared via `typeDefinitions`: does the codegen CLI need all types inlined, or does it resolve references?
- Heterogeneous Map limitation in the tsc engine — does typia have the same issue or does it handle `Map<string, string | number>` correctly?
- Bundle size of typia-generated validator + runtime shim inside the DW — does it fit comfortably in a Worker isolate?
- Cold-start latency of the DW compared to the plain-Worker tsc engine (5.2.6 measured 479ms cold for plain Worker; typia should be lower since it's just loading pre-compiled JS)

## Resolved Concerns

- **Dynamic Workers forbid `new Function`/`eval` — does typia use them?** No. Typia is a pure AST-to-AST transformer; it emits static JS (literal function expressions using `typeof`, property access, `Array.isArray`, regex literals). The generated validator contains no runtime codegen. See typia docs at https://typia.io/docs/setup/. One thing to verify during Phase 3 spike: no feature we actually call (e.g., `typia.json.createStringify`, protobuf codecs) pulls in a runtime helper that itself does dynamic evaluation. Plain-JS helpers are fine; bundle `typia` as a normal dep alongside the generated validator.

- **Can we run typia's transformer in-memory inside a Worker (no disk, no CLI, no child process)?** Yes. Typia's transformer is a standard `ts.TransformerFactory<ts.SourceFile>` exported from `@typia/transform` (v12+; `typia/lib/transform` is a thin re-export). We invoke it programmatically the same way `@lumenize/ts-runtime-validator` already invokes the tsc compiler: `ts.createProgram` with a virtual `CompilerHost`, then `program.emit(undefined, writeFile, undefined, false, { before: [transform(program, options, extras)] })` where `writeFile` captures emitted JS to an in-memory string. `@typia/transform` imports only `typescript`, `@typia/core`, `@typia/utils` — no `fs`/`path`/`process`/`child_process` in the transform hot path.

  **Gotchas to carry into Phase 3:**
  - `strictNullChecks` must be enabled on the `ts.Program`, otherwise typia emits a diagnostic and bails.
  - Dedupe `typescript` — the transformer does instance checks against TS node types, so exactly one `typescript` module must be in the bundle.
  - `ts-patch` / `ttypescript` are only required for the `tsconfig.compilerOptions.plugins` path. Invoking `program.emit(..., { before: [factory] })` directly bypasses that machinery entirely.
  - No public precedent for running typia's transformer in a Worker/browser — we'd be first. No technical blocker since our tsc-in-Worker pattern already proves the virtual-host approach works.
