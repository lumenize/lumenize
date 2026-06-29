# container-dep-install-bench

Point-in-time spike (per `.claude/rules/workflow.md` § Experiments): how expensive is the
cold-start dependency install for the Studio DevContainer's curated UI lib set
(Vue + Vite + Tailwind + Lucide; no native binaries), and which mitigation wins?

It answers the Phase 3.5 image-shape decision (`tasks/nebula-container-dev-loop.md` open Q#1):
**bake the supported deps into the image** vs **install at runtime** vs **pnpm store**.

Plain Docker only — NOT wrangler / `LumenizeContainer` — so it sidesteps the Colima
`proxy-everything` blocker ([[lumenize-container-local-dev]]). `--cpus=0.5` approximates the
`standard-1` (½ vCPU) instance the dev loop runs on.

Run: `sh bench.sh` (needs Docker; Colima is fine). Results captured in `RESULTS.md`.

Measures:
1. npm install COLD (no cache) — the runtime-install cold-start penalty, + node_modules size.
2. npm install with a WARM cache (download skipped) — isolates download vs unpack cost.
3. pnpm install with a WARM store — the hardlink-from-store "install = link" speedup.
4. Baked image — `docker build` one-time cost + image/node_modules size (cold start = 0 install).
5. Version-bump clutter — does `npm install vue@A` then `@B` leave the old version behind?
