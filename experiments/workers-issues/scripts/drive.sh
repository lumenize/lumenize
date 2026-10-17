#!/usr/bin/env bash
# Hits every route three times, n = 1..3, and prints each status.
set -u
BASE="${BASE:-https://experiment-workers-issues.transformation.workers.dev}"
# Round 1 by default; ROUTES="q r t u v w x y" bash scripts/drive.sh for round 2.
read -r -a ROUTES <<< "${ROUTES:-a b0 b b2 c d e f g h i j k l n1 n2}"
for n in 1 2 3; do
  for r in "${ROUTES[@]}"; do
    printf '%-3s n=%s -> %s\n' "$r" "$n" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$r?n=$n")"
  done
  sleep 2
done
