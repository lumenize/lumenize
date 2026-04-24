# forks/typia

Local copy of four typia runtime packages from `samchon/typia@v12.0.2`:

- `@typia/core` — validator emission programmers
- `@typia/transform` — TypeScript transformer that rewrites typia call sites into generated validators
- `@typia/interface` — shared schema interface definitions
- `@typia/utils` — shared utilities

## Why a local copy?

typia's generated validators have no visit tracking, so cycles stack-overflow and DAG aliases get re-walked. Every other Lumenize transport (Workers RPC, `@lumenize/structured-clone`, Mesh `call()`) preserves cycles and aliases end-to-end. We own these four packages in-tree so we can modify typia's emitter to match.

## Modifications against upstream

### Visit-tracking in generated validators

**File**: [core/src/programmers/internal/FeatureProgrammer.ts](core/src/programmers/internal/FeatureProgrammer.ts) — search for `Lumenize modification: visit-tracking`.

**What it does**: generated validators allocate one `WeakMap<object, Set<string>>` per top-level call. Each object-typed named helper (`${prefix}o${index}`) checks its own name against the set at the input; if seen, returns `true` without recursing; otherwise records its name and runs the original body.

**Why keyed by `(object, helper-name)` rather than just object**: `ValidateProgrammer` runs `__is` first, then if that returns `false` runs a full validate pass. Both passes share `$visited` via closure. Without per-helper keying, `__is` marking objects as visited would short-circuit the follow-on validate pass, hiding errors. The helper-name key — `_io0` for is helpers, `_vo0` for validate helpers — keeps the passes independent.

**Entry points touched**:
- `writeDecomposed` — emits `$visited` declaration in IIFE and resets at user-facing arrow entry
- `write` — emits `$visited` declaration inside the per-call arrow (helpers are per-call here)
- `write_object_functions` — wraps each emitted helper body with the per-helper visit guard

**Not touched**: public typia API, parameter signatures, helper call sites. The map is closure-scoped; no threading.

## Workspace wiring

The four sub-directories are registered as local npm workspaces via the monorepo root `package.json`. npm creates symlinks from `node_modules/@typia/*` into these directories. No publishing, no submodule, no fork on GitHub.

Consuming code (including [scripts/bundle-dependencies.mjs](../../scripts/bundle-dependencies.mjs)) imports `@typia/*` by bare specifier; workspace resolution routes to these directories. esbuild consumes the `.ts` source directly via each package's `main: "src/index.ts"` — no tsc step.

## Testing the modifications

End-to-end regression signal lives in [../../test/cycles.test.ts](../../test/cycles.test.ts): self-cycles at nullable and non-nullable positions, DAG aliasing, invalid-node cycles (errors still reported), and mutual A↔B recursion. All parser-validator tests additionally exercise the modified emitter through the standard validation pipeline.

Upstream's own test suite (`@typia/template` + `tests/test-typia-automated/`) is not ported — it brings heavy dependencies (`randexp`, `tstl`, `chalk`, `uuid`, `@nestia/e2e`, `tgrid`, internal `typia/lib/internal/*`) and assumes a ts-patch build-time transform that doesn't compose with our runtime-transform pipeline. If an upstream PR is ever opened against `samchon/typia`, port a curated subset of that suite then.

## License

MIT, per [LICENSE](./LICENSE) — same as upstream typia. See [ATTRIBUTIONS.md](../../../../ATTRIBUTIONS.md) for provenance.
