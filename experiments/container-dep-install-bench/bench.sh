#!/usr/bin/env bash
# Plain-Docker dependency-install bench for the Studio DevContainer curated lib set.
# --cpus=0.5 mimics the standard-1 (½ vCPU) instance. See README.md.
DIR="$(cd "$(dirname "$0")" && pwd)"
IMG=node:22-slim
SEED="-v ${DIR}/package.json:/seed/package.json:ro"
CPU="--cpus=0.5"

timeit() { # label, then the command to time (host wall clock, portable)
  label="$1"; shift
  python3 - "$label" "$@" <<'PY'
import sys, subprocess, time
label = sys.argv[1]; cmd = sys.argv[2:]
t = time.time()
rc = subprocess.run(cmd).returncode
print(f">>> [{label}] wall={time.time()-t:.1f}s rc={rc}")
PY
}

echo "=== dep-install bench  (img=${IMG}, ${CPU}) ==="
docker volume rm depbench_npm depbench_pnpm >/dev/null 2>&1

echo; echo "### [1] npm install COLD (fresh, no cache)"
timeit npm-cold docker run --rm $CPU $SEED $IMG sh -c '
  mkdir -p /app && cp /seed/package.json /app/ && cd /app
  npm install --no-audit --no-fund --silent
  echo "SIZE=$(du -sh node_modules | cut -f1)  TOPLEVEL=$(ls node_modules | grep -vc "^\.")  TOTAL_PKGS=$(find node_modules -name package.json | wc -l | tr -d " ")"
'

echo; echo "### [2] npm install WARM cache (populate, then re-time)"
docker run --rm $CPU $SEED -v depbench_npm:/root/.npm $IMG sh -c \
  'mkdir -p /app && cp /seed/package.json /app/ && cd /app && npm install --no-audit --no-fund --silent' >/dev/null 2>&1
timeit npm-warmcache docker run --rm $CPU $SEED -v depbench_npm:/root/.npm $IMG sh -c '
  mkdir -p /app && cp /seed/package.json /app/ && cd /app
  npm install --no-audit --no-fund --silent && echo "(warm-cache install done)"
'

echo; echo "### [3] pnpm install WARM store (populate, then re-time)"
docker run --rm $CPU $SEED -v depbench_pnpm:/pnpm-store $IMG sh -c \
  'corepack enable && pnpm config set store-dir /pnpm-store >/dev/null && mkdir -p /app && cp /seed/package.json /app/ && cd /app && pnpm install --silent' >/dev/null 2>&1
timeit pnpm-warmstore docker run --rm $CPU $SEED -v depbench_pnpm:/pnpm-store $IMG sh -c '
  corepack enable && pnpm config set store-dir /pnpm-store >/dev/null
  mkdir -p /app && cp /seed/package.json /app/ && cd /app
  pnpm install --silent
  echo "PNPM_NODE_MODULES=$(du -sh node_modules | cut -f1)  STORE=$(du -sh /pnpm-store | cut -f1)"
'

echo; echo "### [4] baked image  (docker build = one-time cost)"
timeit bake-build docker build -q -f "${DIR}/Dockerfile.baked" -t depbench-baked "${DIR}"
docker run --rm depbench-baked sh -c 'echo "BAKED_NODE_MODULES=$(du -sh node_modules | cut -f1)  vite=$(./node_modules/.bin/vite --version)"'
docker image inspect depbench-baked --format "BAKED_IMAGE_SIZE={{.Size}} bytes" 2>/dev/null

echo; echo "### [5] version-bump clutter (npm i vue@3.4.21, then vue@3.5.13)"
docker run --rm $CPU $IMG sh -c '
  mkdir -p /app && cd /app && npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund --silent vue@3.4.21
  echo "top-level vue after 3.4.21: $(node -p "require(\"/app/node_modules/vue/package.json\").version")"
  npm install --no-audit --no-fund --silent vue@3.5.13
  echo "top-level vue after 3.5.13: $(node -p "require(\"/app/node_modules/vue/package.json\").version")"
  echo "distinct vue package.json in tree: $(find node_modules -path "*/vue/package.json" | wc -l | tr -d " ")"
  npm ls vue 2>/dev/null || true
'

echo; echo "=== done ==="
docker volume rm depbench_npm depbench_pnpm >/dev/null 2>&1
