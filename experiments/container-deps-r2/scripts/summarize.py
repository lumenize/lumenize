"""Summarize the rounds: per arm, the time to ready, to fetch and unpack, to build, and the whole op.

    python3 -I scripts/summarize.py results/rounds-<stamp>.jsonl

The whole op is `workerMs`: start() to the build's end, plus a few hundred ms of du and destroy.
Rounds before the BUILD fix (19:47:38Z) ran `npx` with npm's update notifier on, which cost the
plain image ~25 s (RESULTS.md); their r2-full builds are reported apart.
"""
import json
import statistics
import sys

FIX_AT = "2026-11-18T19:47:38"


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return "-"
    xs.sort()
    return f"n={len(xs):2} min={xs[0]/1000:5.1f} med={statistics.median(xs)/1000:5.1f} max={xs[-1]/1000:5.1f}"


rows = [json.loads(line) for f in sys.argv[1:] for line in open(f)]
errors = [r for r in rows if r.get("error")]
arms = {}
for r in rows:
    label = r["label"]
    if label == "r2-full" and r["at"] < FIX_AT:
        label = "r2-full (npx notifier)"
    arms.setdefault(label, []).append(r)

for label, rs in arms.items():
    print(f"\n{label}")
    print(f"  ready   {stats([r.get('readyMs') for r in rs])}")
    if any(r.get("fetchExtractMs") for r in rs):
        print(f"  fetch+x {stats([r.get('fetchExtractMs') for r in rs])}")
    print(f"  build   {stats([r.get('buildMs') for r in rs])}")
    print(f"  whole   {stats([r.get('workerMs') for r in rs])}")
    cold = [(r.get("gapMin"), round(r["readyMs"] / 1000, 1)) for r in rs if (r.get("readyMs") or 0) > 2000]
    if cold:
        print(f"  cold starts (gap min, ready s): {cold}")

print(f"\nerrors: {len(errors)}")
for r in errors:
    print(f"  {r['label']} gap={r.get('gapMin')}: {r['error']}")
