#!/usr/bin/env bash
# Part 1 — install cost. Answers two questions the 20.1 s clean-install number can't:
#   (a) WHAT dominates that 20.1 s? (Larry's hypothesis: tailwind v4's native oxide binary)
#   (b) What does it actually cost to add ONE user dep on top of the BAKED tree?
#       That incremental number — not 20.1 s — is what any restore mechanism has to beat.
#
# --cpus=0.5 mimics the standard-1 (½ vCPU) instance our wrangler.jsonc asks for.
# Timing is taken INSIDE the container around the install only, so ~1 s of container
# start is excluded (the older container-dep-install-bench timed the whole docker run).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
IMG=node:22-slim
CPU="${CPU:---cpus=0.5}"
OUT="${DIR}/raw-install.txt"
: > "$OUT"

say() { printf '%s\n' "$*" | tee -a "$OUT"; }

# Times `npm install <args>` inside a throwaway container seeded with the curated
# package.json. Prints "label<TAB>seconds<TAB>extra".
cold_install() {
  local label="$1"; shift
  local spec="$1"; shift          # "" = install the curated package.json as-is
  local res
  res=$(docker run --rm $CPU -v "${DIR}/fixture/package.json:/seed/package.json:ro" $IMG sh -c '
    set -e
    mkdir -p /app && cd /app
    if [ -n "'"$spec"'" ]; then npm init -y >/dev/null 2>&1; else cp /seed/package.json .; fi
    S=$(date +%s%3N)
    npm install --no-audit --no-fund --silent '"$spec"' >/dev/null 2>&1
    E=$(date +%s%3N)
    SZ=$(du -sm node_modules 2>/dev/null | cut -f1)
    PK=$(find node_modules -name package.json 2>/dev/null | wc -l | tr -d " ")
    printf "%s\t%sMB\t%spkgs\n" "$(( (E-S)/1000 )).$(( (E-S)%1000/100 ))" "$SZ" "$PK"
  ' 2>/dev/null)
  say "$(printf '%-34s %s' "$label" "$res")"
}

say "=== Part 1: install cost  (img=$IMG, $CPU, arch=$(uname -m), $(date -u +%FT%TZ)) ==="
say ""
say "--- [A] cold install of the full curated set (baseline; 2 runs for variance) ---"
say "$(printf '%-34s %-8s %-8s %s' 'scenario' 'wall' 'size' 'pkgs')"
cold_install "curated-full run1" ""
cold_install "curated-full run2" ""

say ""
say "--- [B] cold install of each curated dep ALONE (what dominates?) ---"
say "$(printf '%-34s %-8s %-8s %s' 'scenario' 'wall' 'size' 'pkgs')"
for p in vue vite @vitejs/plugin-vue tailwindcss @tailwindcss/vite daisyui lucide-vue-next typescript; do
  cold_install "alone: $p" "$p"
done

say ""
say "--- [C] native-binary census of the full curated tree ---"
docker run --rm -v "${DIR}/fixture/package.json:/seed/package.json:ro" $IMG sh -c '
  mkdir -p /app && cd /app && cp /seed/package.json .
  npm install --no-audit --no-fund --silent >/dev/null 2>&1
  echo "total node_modules: $(du -sm node_modules | cut -f1) MB, $(find node_modules -name package.json | wc -l | tr -d " ") pkgs"
  echo "--- .node / ELF binaries in tree ---"
  find node_modules -name "*.node" -o -name "*.wasm" 2>/dev/null | head -20
  echo "--- 10 largest packages (MB) ---"
  du -sm node_modules/* node_modules/@*/* 2>/dev/null | sort -rn | head -10
  echo "--- npm cache left behind by the install (this ships in our baked image layer) ---"
  du -sm /root/.npm 2>/dev/null | cut -f1 | sed "s/$/ MB/"
' 2>/dev/null | tee -a "$OUT"

say ""
say "=== [D] THE HEADLINE: incremental install on top of the BAKED tree ==="
say "Baked image = our real Dockerfile shape (curated node_modules + npm cache present)."
docker build -q -t depbench-baked -f "${DIR}/Dockerfile.baked" "${DIR}" >/dev/null 2>&1 \
  && say "baked image built ok" || { say "BAKE FAILED"; exit 1; }

say ""
say "$(printf '%-34s %-8s %-8s %s' 'user dep added to baked tree' 'wall' 'delta' 'pkgs+')"
incr() {
  local label="$1"; shift
  local spec="$*"
  local res
  res=$(docker run --rm $CPU depbench-baked sh -c '
    set -e
    cd /app
    B0=$(du -sm node_modules | cut -f1); P0=$(find node_modules -name package.json | wc -l)
    S=$(date +%s%3N)
    npm install --no-audit --no-fund --silent '"$spec"' >/dev/null 2>&1
    E=$(date +%s%3N)
    B1=$(du -sm node_modules | cut -f1); P1=$(find node_modules -name package.json | wc -l)
    printf "%ss\t+%sMB\t+%s\n" "$(( (E-S)/1000 )).$(( (E-S)%1000/100 ))" "$((B1-B0))" "$((P1-P0))"
  ' 2>/dev/null)
  say "$(printf '%-34s %s' "$label" "$res")"
}
incr "echarts (big bytes, few pkgs)"      "echarts"
incr "ag-grid-community (very big)"        "ag-grid-community"
incr "@tiptap/vue-3 +starter-kit (many)"   "@tiptap/vue-3 @tiptap/starter-kit"
incr "@tanstack/vue-table (small)"         "@tanstack/vue-table"
incr "chart.js (medium)"                   "chart.js"
incr "date-fns (many files, pure JS)"      "date-fns"
incr "NO-OP re-install (tree churn cost)"  ""

say ""
say "--- [E] CPU sensitivity: same two measurements at --cpus=2 ---"
CPU="--cpus=2"
cold_install "curated-full @2cpu" ""
res=$(docker run --rm $CPU depbench-baked sh -c '
  cd /app; S=$(date +%s%3N); npm install --no-audit --no-fund --silent echarts >/dev/null 2>&1; E=$(date +%s%3N)
  echo "$(( (E-S)/1000 )).$(( (E-S)%1000/100 ))s"' 2>/dev/null)
say "$(printf '%-34s %s' 'incr echarts @2cpu' "$res")"

say ""
say "raw output: $OUT"
