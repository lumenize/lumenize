# Results — container cold-start probe (2026-07-20)

Deployed throwaway probe on real Cloudflare hardware. Nebula's **real** DevContainer image, the
build-box sequence (cold start → restore source → optional `npm install` → `vite build` → return dist),
`dep=0` = baked path, `dep=1` = user adds one big dep (`echarts`). DO-side marks separated by awaited
`containerFetch` (valid per the `cf-clock-traps` memory) and cross-checked against an external observer
on first use — they agreed within ~0.9 s, so DO-side timing is trusted below.

**Headline: the local-Docker numbers in [container-dep-restore-bench](../container-dep-restore-bench/RESULTS.md)
were 3–5× optimistic. Use these for any budgeting.**

| scenario | total |
|---|---|
| baked (common case) | **8–10 s** — build 6.8–9.3 s, stable across every session |
| user dep, good colo, sized up | **11–12 s** |
| user dep, standard-1 | **26–33 s** |
| user dep, bad colo (EWR) | **33 s** — sizing does not rescue it |

**Cold start was 0.3–1.6 s throughout** and never varied much — it is both small and the only term that
hides behind a codegen turn. The build is **70–90 %** of every scenario.

---

## 1. Container placement does NOT follow the caller

The single most useful thing measured. The probe asks the container itself which colo its egress lands
in, rather than inferring placement from the caller's entry PoP.

**Entry PoP was `IAD` on every single run. The containers ran in `MIA`, `EWR`, `CMH`, `YYZ` — never
`IAD`.** Cloudflare places containers where container capacity exists, not near the requester.

⇒ **You cannot buy local placement by choosing DO ids/names.** The probe already used a fresh
`newUniqueId()` per run (so every run got fresh first-touch placement); placement still scattered. This
was worth testing because a natural assumption — "pick a different DO name and you land locally" — turns
out to be false for container-backed DOs.

## 2. Colo is a large, uncontrolled nuisance variable

Same session, `standard-4`, `dep=1`:

| colo | build |
|---|---|
| CMH | 7.7 s |
| MIA | 8.7 s |
| **EWR** | **28.1 s** |

EWR was ~3.5× the others, and was also the slowest at `standard-1` (27.0 s). **One colo being
pathological is a bigger effect than instance sizing.** A user whose build lands on a bad colo gets a
~30 s turn regardless of configuration.

## 3. Instance sizing DOES help — ~2.7×, once colo is held constant

This is the finding that required controlling for §2; earlier passes compared across sessions and colos
with neither controlled, and produced contradictory conclusions in both directions.

Same session, same colo, `dep=1` build:

| colo | standard-1 | standard-4 |
|---|---|---|
| MIA | 25.7 / 21.8 s | 8.7 s |
| CMH | 21.3 s | 7.7 s |
| EWR | 27.0 s | 28.1 s (no gain) |

⇒ sizing up is worth ~2.7× on a *healthy* colo and nothing on a bad one.

## 4. WARP is irrelevant; the "session effect" is real but unexplained

An earlier pass appeared to show a clean before/after-WARP split (builds 8–12 s vs 20–32 s, zero
overlap). **That was a coincidence of timing.** With WARP *off* again, builds stayed at 21–27 s, and the
entry PoP was `IAD` in both states — WARP never moved it.

What remains is a genuine between-session shift (~2.5×) that neither WARP, instance type, nor measured
colo explains. Leading candidate is CF fleet load / time of day. **Unresolved.**

## 5. The baked path is stable; only the heavy path swings

`dep=0` total was 8.1–10.8 s in *every* session and configuration. `dep=1` ranged 10.9–38.9 s. Whatever
drives the variance is specific to the larger build (bigger bundle, more transform work, possibly memory
pressure) — untested hypothesis.

---

## Raw data

`dep=1` build times, by session. Session C is the only one where colo was recorded.

| session | config | builds (s) |
|---|---|---|
| A (colo unknown) | standard-1 | 9.4, 10.6, 8.2, 12.2, 9.2 |
| A | standard-2 | 10.0, 12.0, 24.1, 12.7 |
| A | standard-3 | 17.7 |
| A | standard-4 | 30.9, 22.2, 9.4, 12.5 |
| B (WARP on, IAD) | standard-1 | 24.2, 21.2, 28.6, 22.6, 31.6, 19.6 |
| C (WARP off, IAD) | standard-1 | 25.7 (MIA), 27.0 (EWR), 21.3 (CMH), 25.2 (YYZ), 21.8 (MIA) |
| C | standard-4 | 28.1 (EWR), 7.7 (CMH), 8.7 (MIA) |

`dep=0`: A/standard-2 → cold 1.34, build 9.01, total 10.42 · A/standard-4 → cold 1.43, build 9.31,
total 10.83 · B/standard-1 → build 6.80, 7.67 · C/standard-1 → 8.29 (EWR), 7.34 (CMH), 7.86 (YYZ),
totals 8.1–9.4.

`npm install` of one dep: 2.3–6.6 s. `restore source` and `return dist`: <0.15 s in every run.

## Limitations — read before citing any of this

- **n = 3–5 per cell**, with colo (a ~3.5× factor) uncontrolled and only *measured* in session C. The
  §3 sizing conclusion rests on 3 within-session colo-matched pairs. It is the best-controlled
  comparison here, but it is not a powered result.
- **Sessions are confounded with time of day** and with cumulative account container usage.
- **~15 % of requests (2 of 13 in one round) returned non-JSON** and were retried without capturing the
  body — an uncharacterized failure mode. Retries all succeeded.
- Single account, single app, single region-ish (all entries `IAD`).
- Resolving sizing properly needs many samples per (instance_type × colo) cell — and colo is *assigned,
  not chosen*, so coverage only comes from volume. That is a real experiment, not a side quest.

## What this settles for the snapshot question

Nothing changes the [backlog.md](../../tasks/backlog.md) verdict, and one thing strengthens it: the cost
snapshots would remove (cold start ~1 s, and at most the ~4 s install) is **not** where the time goes.
The build is 70–90 % of every scenario, and neither snapshots nor restore mechanisms touch it.
