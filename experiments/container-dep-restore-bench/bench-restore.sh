#!/usr/bin/env bash
# Part 2 — restore bake-off. Given a per-tenant node_modules that already exists
# somewhere, what is the cheapest way to get it onto a FRESH container and build?
#
# The metric that matters is END-TO-END: fresh container → working node_modules →
# `vite build` produces dist. Restore-to-usable alone is misleading, because the
# lazy methods (squashfs mount) defer their cost into the build's read path. So we
# time both halves and report the total.
#
# Methods:
#   control  baked into the image           (what we do today — 0 s restore)
#   npm      cold `npm install`             (the 20 s path we're trying to beat)
#   tar.gz   fetch-equivalent + extract     (gzip: small archive, slow decompress)
#   tar.zst  fetch-equivalent + extract     (zstd: bigger archive, fast decompress)
#   sqsh-ro  squashfs mounted READ-ONLY     (lazy page-in, no copy)
#   sqsh-ovl squashfs + tmpfs overlay       (CF restoreBackup()'s actual shape: COW)
#
# NOTE ON FETCH: archive fetch time is a pure bandwidth term and would be measured
# against real R2 in Leg B. Here we hold the archive on a local volume and report
# archive SIZE, so fetch time can be computed for any bandwidth rather than faked.
# The extract/mount numbers below are therefore a LOWER BOUND on the real thing.
#
# `--privileged` is required for loop-mounting squashfs and for overlayfs. That is a
# local-measurement affordance; on CF the equivalent is their FUSE path, which is why
# squashfuse is also measured where possible.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CPU="${CPU:---cpus=0.5}"
ART="${DIR}/artifacts"
OUT="${DIR}/raw-restore.txt"
: > "$OUT"
mkdir -p "$ART"

say() { printf '%s\n' "$*" | tee -a "$OUT"; }

say "=== Part 2: restore bake-off  ($CPU, arch=$(uname -m), $(date -u +%FT%TZ)) ==="

say ""
say "--- building images ---"
docker build -q -t depbench-baked -f "${DIR}/Dockerfile.baked" "${DIR}" >/dev/null 2>&1 || { say "baked build FAILED"; exit 1; }
docker build -q -t depbench-tools -f "${DIR}/Dockerfile.tools" "${DIR}" >/dev/null 2>&1 || { say "tools build FAILED"; exit 1; }
docker build -q -t depbench-bare  -f "${DIR}/Dockerfile.bare"  "${DIR}" >/dev/null 2>&1 || { say "bare build FAILED";  exit 1; }
say "ok: depbench-baked / depbench-tools / depbench-bare"

# ---------------------------------------------------------------- create artifacts
say ""
say "--- [A] archive CREATION (the 'backup' half — paid once per dep-set change) ---"
say "$(printf '%-24s %-10s %s' 'artifact' 'create' 'size')"
docker run --rm $CPU -v "${ART}:/art" depbench-tools sh -c '
  set -e
  cd /app
  t() { S=$(date +%s%3N); "$@" >/dev/null 2>&1; E=$(date +%s%3N); echo "$(( (E-S)/1000 )).$(( (E-S)%1000/100 ))s"; }
  G=$(t tar czf /art/node_modules.tar.gz node_modules)
  Z=$(t tar -c --zstd -f /art/node_modules.tar.zst node_modules)
  Q=$(t mksquashfs node_modules /art/node_modules.sqsh -noappend -comp zstd)
  RAW=$(du -sm node_modules | cut -f1)
  NF=$(find node_modules -type f | wc -l | tr -d " ")
  ND=$(find node_modules -type d | wc -l | tr -d " ")
  printf "%-24s %-10s %s\n" "raw node_modules"  "-"  "${RAW}MB / ${NF} files / ${ND} dirs"
  printf "%-24s %-10s %s\n" "node_modules.tar.gz"  "$G" "$(du -m /art/node_modules.tar.gz  | cut -f1)MB"
  printf "%-24s %-10s %s\n" "node_modules.tar.zst" "$Z" "$(du -m /art/node_modules.tar.zst | cut -f1)MB"
  printf "%-24s %-10s %s\n" "node_modules.sqsh"    "$Q" "$(du -m /art/node_modules.sqsh    | cut -f1)MB"
' 2>/dev/null | tee -a "$OUT"

# ---------------------------------------------------------------- restore + build
say ""
say "--- [B] END-TO-END: fresh container → node_modules → vite build ---"
say "$(printf '%-12s %-12s %-12s %-12s %s' 'method' 'restore' 'build' 'TOTAL' 'notes')"

run_case() { # label, extra docker args, inner script
  local label="$1"; local xargs="$2"; local inner="$3"
  local res
  res=$(docker run --rm $CPU $xargs -v "${ART}:/art:ro" "${IMAGE:-depbench-bare}" sh -c "
    set -e
    cd /app
    RS=\$(date +%s%3N)
    $inner
    RE=\$(date +%s%3N)
    BS=\$(date +%s%3N)
    ./node_modules/.bin/vite build >/dev/null 2>&1
    BE=\$(date +%s%3N)
    R=\$((RE-RS)); B=\$((BE-BS)); T=\$((BE-RS))
    printf '%d.%ds %d.%ds %d.%ds %s\n' \
      \$((R/1000)) \$((R%1000/100)) \$((B/1000)) \$((B%1000/100)) \$((T/1000)) \$((T%1000/100)) \
      \"dist=\$(du -sk dist | cut -f1)KB\"
  " 2>/dev/null)
  if [ -z "$res" ]; then res="FAILED"; fi
  say "$(printf '%-12s %s' "$label" "$res")"
}

IMAGE=depbench-baked run_case "control"  ""            "true   # deps already in image"
IMAGE=depbench-bare  run_case "npm-cold" ""            "npm install --no-audit --no-fund --silent"
IMAGE=depbench-bare  run_case "tar.gz"   ""            "tar xzf /art/node_modules.tar.gz"
IMAGE=depbench-bare  run_case "tar.zst"  ""            "tar -x --zstd -f /art/node_modules.tar.zst"
# sqsh-ro FAILS BY DESIGN — kept because the failure is the finding: vite must WRITE
# into node_modules (`.vite-temp`, for loading a TS vite.config) so a read-only mount
# of node_modules cannot build at all. This is why CF's restoreBackup() uses a COW
# overlay rather than a plain ro mount — and why the simplest "just mount node_modules
# from R2 read-only" shape is a non-starter.
IMAGE=depbench-bare  run_case "sqsh-ro"  "--privileged" \
  "mkdir -p node_modules && mount -t squashfs -o loop,ro /art/node_modules.sqsh node_modules"
# upperdir MUST be on a real fs — overlayfs refuses an overlayfs upperdir, and Docker's
# rootfs is overlayfs, so the upper/work dirs go on a tmpfs.
IMAGE=depbench-bare  run_case "sqsh-ovl" "--privileged" \
  "mkdir -p /mnt/low /mnt/ovl node_modules
   mount -t tmpfs tmpfs /mnt/ovl
   mkdir -p /mnt/ovl/up /mnt/ovl/wk
   mount -t squashfs -o loop,ro /art/node_modules.sqsh /mnt/low
   mount -t overlay overlay -o lowerdir=/mnt/low,upperdir=/mnt/ovl/up,workdir=/mnt/ovl/wk node_modules"
# squashfuse is the userspace mounter CF actually uses; also read-only, so it needs the
# same overlay on top.
IMAGE=depbench-bare  run_case "sqshfuse" "--privileged --device /dev/fuse" \
  "mkdir -p /mnt/low /mnt/ovl node_modules
   mount -t tmpfs tmpfs /mnt/ovl
   mkdir -p /mnt/ovl/up /mnt/ovl/wk
   squashfuse /art/node_modules.sqsh /mnt/low
   mount -t overlay overlay -o lowerdir=/mnt/low,upperdir=/mnt/ovl/up,workdir=/mnt/ovl/wk node_modules"

say ""
say "--- [C] second build in the same container (warm page cache) ---"
say "Exposes whether the lazy methods only pay page-in once."
for m in "control:depbench-baked::true" \
         "tar.zst:depbench-bare::tar -x --zstd -f /art/node_modules.tar.zst" \
         "sqsh-ro:depbench-bare:--privileged:mkdir -p node_modules && mount -t squashfs -o loop,ro /art/node_modules.sqsh node_modules"; do
  IFS=: read -r lbl img xa inner <<<"$m"
  res=$(docker run --rm $CPU $xa -v "${ART}:/art:ro" "$img" sh -c "
    set -e; cd /app; $inner
    ./node_modules/.bin/vite build >/dev/null 2>&1
    S=\$(date +%s%3N); ./node_modules/.bin/vite build >/dev/null 2>&1; E=\$(date +%s%3N)
    printf '%d.%ds\n' \$(( (E-S)/1000 )) \$(( (E-S)%1000/100 ))
  " 2>/dev/null)
  say "$(printf '%-12s 2nd build: %s' "$lbl" "${res:-FAILED}")"
done

say ""
say "raw output: $OUT   artifacts: $ART"
