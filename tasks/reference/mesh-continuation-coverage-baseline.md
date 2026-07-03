# Mesh coverage baseline — BEFORE `mesh-continuation-only-calls` Phase 1

Captured 2026-07-03, on `pre-alpha` at HEAD `c8d1646`, **before any code change** — the parity yardstick for [`mesh-continuation-only-calls.md`](../mesh-continuation-only-calls.md) Phase 1 criterion #1 / Phase 2 parity bar (Branch>80 / Statement>90 on rewritten paths).

**Measurement scope (reproduce identically after):**
```sh
cd packages/mesh
LUMENIZE_NO_CF_REMOTE=1 npx vitest --run --coverage \
  --project main --project getting-started --project calls --project alarms --project security
```
Pool-workers projects only. **Excluded** (measure separately if a rewritten path lands there): `browser` (needs CF remote-email creds — most of `lumenize-client.ts`) and `container` (needs Docker — all of `lumenize-container.ts`, hence its 0% here). So `lumenize-worker.ts` (30%), `lumenize-container.ts` (0%), and part of `lumenize-client.ts` are **under-counted** in this scope — their real coverage comes from the omitted projects + `apps/nebula` app tests.

**Result: 18 test files, 392 tests passed.** Aggregate: Stmts 83.17% (969/1165), Branch 74.4% (497/668), Funcs 82.28%, Lines 84.13%.

Per-file (the files this task rewrites, in **this scope**):

| File | % Stmts | % Branch | % Funcs | % Lines |
|---|---|---|---|---|
| `src/lmz-api.ts` | 95.00 | 87.38 | 97.36 | 94.89 |
| `src/lumenize-do.ts` | 88.23 | 65.62 | 83.33 | 89.23 |
| `src/lumenize-worker.ts` | 30.55 | 14.28 | 77.77 | 32.25 |
| `src/lumenize-container.ts` | 0 | 0 | 0 | 0 |
| `src/lumenize-client.ts` | 88.00 | 75.00 | 78.12 | 88.95 |
| `src/lumenize-client-gateway.ts` | 85.37 | 79.80 | 84.61 | 85.71 |
| `src/ocan/execute.ts` | 82.72 | 78.88 | 100 | 82.69 |
| `src/broadcast.ts` | 13.63 | 0 | 0 | 14.28 |

(`broadcast.ts` low here because its exercised paths are the tier-Worker fanout driven by `apps/nebula` app tests, not the mesh pool-workers suite.)
