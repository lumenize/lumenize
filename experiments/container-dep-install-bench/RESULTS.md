# Results — container dep-install bench (2026-06-18)

Plain Docker, `node:22-slim`, `--cpus=0.5` (≈ `standard-1` ½ vCPU). Curated UI set:
Vue 3.5 + Vite 6 + Tailwind 4 (`@tailwindcss/vite`) + Lucide. **No native binaries.**
Wall times include ~1 s container start; treat as ±1 s.

| # | scenario | wall | notes |
|---|---|---|---|
| 1 | `npm install` COLD (empty `~/.npm`) | **20.1 s** | `node_modules` = **84 MB**, 32 top-level / 62 total pkgs |
| 2 | `npm install` WARM cache (persistent `~/.npm`) | **5.1 s** | download/metadata skipped → only unpack+link remains |
| 3 | `pnpm install` WARM store (persistent store) | **6.3 s** | store = 85 MB; incl. ~2 s corepack pnpm download each run |
| 4 | baked image (`RUN npm install` layer) | **~20 s first build**, 0.4 s cached | image = **139 MB**; cold start = **0 install** |
| 5 | version bump (`vue@3.4.21` → `@3.5.13`) | — | **1** vue in tree, `npm ls` clean/deduped — no clutter |

## Conclusions

- **Cold install is ~20 s at ½ vCPU; warm cache is ~5 s.** So download/metadata ≈ 15 s, unpack+link ≈ 5 s.
- **The warm path does NOT exist on Cloudflare.** CF containers have **no persistent volume across
  instances** — every cold start boots from the image with an empty `~/.npm`. So a runtime
  `npm install` is *always* the ~20 s cold path, never the 5 s warm path. The image layer is the only
  durable store.
- **⇒ Bake the curated deps into the image.** Cold start then runs **zero install** (deps already on
  disk); only the user-developer's source re-hydrates from Galaxy. `node_modules` is only 84 MB / image
  139 MB — cheap to bake. First-bake cost (~20 s) is paid once at image build, not per cold start.
- **A registry proxy / R2 mirror can't win.** It would shave the ~15 s download, but the ~5 s unpack
  *still recurs every cold start* (no persistent disk), and it's still container egress (the deferred
  `interceptHttps`/CA-trust work). Bake reaches 0 with zero runtime egress. Rejected.
- **pnpm doesn't beat npm here** (6.3 s vs 5.1 s warm) — the set is too small for the hardlink win to
  show, and corepack re-downloads pnpm each run. pnpm's real value is **multi-version dedup**: a baked
  content-addressable store holds several supported versions cheaply, with per-app install = a hardlink
  farm. If multi-version support matters, bake the **pnpm store** as the image layer rather than a flat
  `node_modules`.
- **"npm leaves old versions behind" is old news.** npm v10 reconciles to the lockfile and dedupes —
  `vue@3.4.21` → `@3.5.13` left exactly one vue. So a "reinstall on change" approach stays clean, but
  on CF it still pays the ~20 s cold path every restart vs 0 baked.

**Decision input for `tasks/nebula-container-dev-loop.md` Phase 3.5 open Q#1:** bake the curated set
(flat `node_modules`, or a pnpm store for multi-version) into the image; reserve runtime install only
for a rare per-app extra pin — and accept that such a pin re-installs (~its download+unpack) on every
cold start, so keep the baked set covering the common case.

Caveat: measured on Apple-silicon Colima (arm64), plain Docker — not the real CF runtime. Absolute
times on CF `standard-1` may differ; the *relative* story (bake = 0, runtime = always-cold, proxy
can't reach 0) holds because it follows from CF's no-persistent-volume model, not from these timings.
