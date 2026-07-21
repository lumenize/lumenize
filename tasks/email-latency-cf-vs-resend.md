# Email latency — Cloudflare vs Resend, measured

**Status:** ✅ DONE — measured 2026-07-21. **Both providers are ~1.4 s and statistically indistinguishable. Do not switch; there is nothing to win.** The premise this task inherited (Resend ~8 s vs Cloudflare ~1 s) was false — see § Results.

**Question:** how long does a real magic-link round trip actually take on each provider, and can the fast one be the local default?

---

## Results (2026-07-21)

Measured on the two existing lanes, instrumented in place — no experiment directory. `reportEmailLatency` in `packages/auth/test/e2e-email/email-test-helpers.ts` now prints one greppable line per loop, so **this is re-derivable on any run, never again a frozen quote**:

```
[email-latency] provider=cloudflare label=full-flow loop=1451ms wsOpen=324ms
```

The measured interval is exactly the loop, not the suite: **magic-link POST issued → link in hand** (the WS push carrying the email). Pool startup, harness setup and teardown are outside it.

### The numbers

| Loop | n | min | **median** | mean | max |
|---|--:|--:|--:|--:|--:|
| **Cloudflare** — first email in a fresh run | 9 | 1293 | **1451 ms** | 1553 | 2565 |
| **Resend** — first email in a fresh run | 10 | 1123 | **1400 ms** | 1434 | 1803 |
| **Cloudflare** — *second* email in the same run | 9 | 887 | **929 ms** | 1067 | 2041 |

**First-run / cold** (provider path idle ≥ 7 min): Cloudflare **1785 ms**; Resend **1332 ms** and **1803 ms** (two separate cold samples). Runs alternated CF/Resend so both saw the same drift.

### What this says

1. **The two providers are indistinguishable.** 1451 ms vs 1400 ms, with per-provider spread far wider than the gap between them. Resend is, if anything, marginally *faster* at the median. Any statement that ranks these two on latency is noise-fitting.
2. **Neither has a cold-start penalty worth naming.** Cold lands inside the warm spread for both. The specific expectation in `testing.md` that *"Resend in particular has an idle penalty"* **did not reproduce** — its two cold samples (1332 / 1803 ms) straddle its own warm median.
3. **The marginal cost of one more real login inside an already-running suite is ~0.9 s** (the second-email row — same isolate, warm connections). This is the number that actually bears on "can real login be the default tier", and it is the smallest of the three.
4. **The WS-connect floor is not binding.** `wsOpen` ran 333 ms median / 425 ms max, well under every loop measured, so the listener was always waiting before the email landed. (It *is* a real floor — `EmailTestDO` pushes only to connected sockets and never replays stored mail — so it is now recorded on every line rather than assumed.)

### Method / caveats

- Timed in-isolate with `Date.now()` across real network I/O, which advances it (per the `cf-clock-traps` correction). **Corroborated against an external observer**: vitest's own per-test durations bracket each loop with ~250 ms of post-email test work (e.g. 1646 ms test / 1391 ms loop), so the in-isolate clock is not lying.
- The **receive half is identical for both** — same `test@lumenize.io`, same deployed email-test Worker, same WS push — so it cancels out of the comparison.
- On the send half, the local CF lane pays a `remote: true` proxy hop from this laptop to Cloudflare; Resend pays an HTTPS hop from the same laptop. Roughly symmetric, and it is the **local test lane** that the decision is about. A *deployed* worker would send CF-side without the proxy hop and could be faster than measured here — but that is not the lane in question.

---

## The ~8 s figure was never measured on Resend

The inherited premise does not survive contact with its own provenance:

- **The cited instrument has no timer.** ADR-009 attributes "~8 s on Resend and ~1-3 s on Cloudflare" to `apps/nebula/harness/prod.ts spin` (2026-07-06). That command contains no `Date.now()` anywhere in its call path — the number is a hand-wall-clocked `npx tsx …` invocation, which also bundles tsx process boot, two `.dev.vars` reads, a `POST /clear`, and a WS handshake before any email is sent. ADR-009's own parenthetical already conceded this ("a standalone measurement pays fresh process + WS-connect overhead").
- **That instrument sends via Cloudflare, not Resend.** `prod.ts spin` targets the deployed `apps/nebula` worker. Its config on that date (`git show f9f80e5:apps/nebula/wrangler.jsonc`) declared a `send_email` `EMAIL` binding and **no** `EMAIL_PROVIDER` — and `createEmailTransport` returns `CloudflareEmailTransport` on `if (e.EMAIL)` (`packages/email/src/create-email-transport.ts:65-67`). `EMAIL_PROVIDER` has never appeared in that file (`git log -S`). So the one instrument named for both numbers could only ever have exercised the Cloudflare path.
- **Nothing re-derived it.** All five in-repo sites quote the ADR; `git log -S"~8s"` finds no earlier measurement, RESULTS.md, or experiment.

Provenance being broken does not by itself prove ~8 s never happened somewhere — but it is not reproducible in this apparatus, and it should not have been load-bearing.

---

## Answers to the task's open questions

**Does the CF `send_email` binding require `remote: true`? — YES, unambiguously.** Removing it and running the lane: miniflare *simulates* the binding, printing `send_email binding called with MessageBuilder:` and writing the rendered HTML to a temp file under `.../miniflare-*/email/email-html/…`. Nothing is sent; both tests time out. Restored immediately after.

Consequences, both directions:
- A local CF fast path **does** need Cloudflare credentials at pool load — locally that is the `wrangler login` OAuth session (no stored key), which is why the existing lane works on this machine.
- A **hosted-CI** binding would need a stored privileged token, which is exactly the blast-radius argument that put Nebula on Resend. That argument stands, and this measurement gives no reason to revisit it.
- Useful side-finding: the local simulation writing rendered HTML to disk is a real affordance for offline template work — but it is a synthetic path, not a send.

**Is `lumenize.io` verified in Email Routing? — YES.** Confirmed via the Cloudflare API, not inference: zone `ad23bbd4…`, Email Routing `enabled: true`, `status: "ready"`, `synced: true`; catch-all `*@lumenize.io` → `email-test` Worker (plus explicit rules for `test@` and `claude@`); `test@lumenize.io` a verified destination since 2026-06-03; DNS carries CF DKIM (`cf2024-1._domainkey`), SPF, `DMARC p=reject`, and the `cf-bounce` sending subdomain. The lane's green runs are the end-to-end proof.

---

## Recommendation

**Do not switch local Nebula test email to Cloudflare. Close the backlog item as not-worth-doing.**

The switch was justified entirely by a latency gap that does not exist. Building it would add a `remote: true` credential dependency at pool load — the thing that forces the `LUMENIZE_NO_CF_REMOTE` opt-out to exist at all — in exchange for ~50 ms of median noise. That is a cost with no benefit, and a second lane-conditional email config for future sessions to unlearn.

**The gating shape question is therefore moot** — no new gate is needed, because no lane changes. `packages/auth` keeps its CF canary behind the existing opt-out; every Nebula lane keeps the provider it already has.

**What the measurement actually settles is the thing worth carrying forward:** a real login costs **~1.4 s standalone, ~0.9 s marginal inside a running suite.** That is the number `testing.md` § Philosophy needs, and it is comfortably cheap enough that reaching for a shortcut cannot be justified on speed.

⚠️ **Open, for Larry — ADR-009 rung 2.** Its stated rationale was "8 s is too slow to put in every unit test." At ~0.9 s marginal that rationale is gone. Rung 2 may still be worth keeping on *other* grounds (no external dependency, determinism, no email infrastructure in a pure unit test) — but those grounds are not currently written down. The cost line has been corrected as a factual matter; **whether the ladder itself changes is a decision, not a measurement, and is left untouched.**

## Why this matters more than a perf nit

`testing.md` now makes *"drive a real `NebulaClient` through the real login"* the **default** tier for Nebula behavior. That default only holds if the round trip is cheap enough that nobody reaches for a shortcut — and reaching for shortcuts is exactly what produced the login-shortcut era (low fidelity → real bugs through, ossified fixtures, deferred building what the feature needed to be usable).

⚠️ **The number is load-bearing beyond this task.** [ADR-009](../docs/adr/009-real-auth-path.md) justifies its rung-2 (test-mode server issuance) partly on *"a real login round-trip is ~8s … the reason rung 2 exists for fast units."* If the local path is ~1s, that justification mostly evaporates and the ADR's cost line should be rewritten — it is the sentence a future session will cite to reach for a shortcut.

## ⚠️ NOT an experiment directory — the apparatus already exists

Two comparable lanes are already built and run the same magic-link loop:

| Lane | Provider | Binding |
|---|---|---|
| `packages/auth/test/e2e-email` | Cloudflare | `send_email` **with `remote: true`** |
| `packages/auth/test/e2e-email-resend` | Resend | none (REST) |

Building a parallel spike under `experiments/` would be a throwaway artifact measuring something we can measure directly — the exact anti-pattern `workflow.md` § unlearning tax now warns about ("a test is a consumer"). **Measure the real lanes.**

## Method

1. **Baseline both**, several runs each, warm and cold — `testing.md` notes first-run-after-idle is a cold start, not a bug, and Resend in particular has an idle penalty. Report median *and* first-run separately; a default is chosen on the median, but a developer feels the cold one.
2. **Time the loop, not the suite** — instrument from magic-link request to link receipt, so setup/teardown and pool startup don't contaminate it.
3. **Answer the `remote: true` question** (the standing OPEN item in `cf-email-sending-vs-routing`): the CF lane declares `remote: true` today, but nobody has tried without it. It gates two things — whether a local fast path needs stored creds at all, and whether a hosted-CI binding is possible. ⚠️ `remote: true` binds at **pool load**, so a creds failure kills the whole project, not one test (`vitest-remote-binding-load-time`).
4. **Confirm `lumenize.io` is verified** in Email Routing — the whole CF path depends on it, and it is listed as unconfirmed.

## Success criteria — all met

- ✅ Median and first-run latency for both providers, from the same loop, with run counts → § Results. CF **1451 ms** (n=9) / Resend **1400 ms** (n=10) median; cold 1785 / 1332–1803 ms.
- ✅ Yes/no on `remote: true` → **YES, required.** Without it miniflare simulates the send and nothing leaves the machine.
- ✅ A recommendation on the local default → **don't switch.** No new gating shape is needed, because no lane changes — that criterion is moot, not skipped.
- ✅ The ADR-009 cost line → **CF did not win, so the edit is not "CF is faster" but "the ~8 s was never measured on Resend, and both are ~1.4 s."** Applied to `docs/adr/009-real-auth-path.md` (Context + Negative) and the always-loaded one-liner in `.claude/rules/workflow.md`. Decision and ladder untouched; the rung-2 rationale question is flagged for Larry above.

## What is already settled — do not re-derive

- ✅ **No 200/day concern.** The beta cap is on the arbitrary-recipient **Email Sending** feature. Verified addresses/domains send via **Routing** instead, so it never touches `*@lumenize.io` test email — double-confirmed with Cloudflare employees. This has been misread repeatedly; if you find yourself about to write "beta 200/day" as a caveat here, stop.
- ✅ **The transport is already provider-agnostic.** `createEmailTransport` selects by env: an `EMAIL` binding → Cloudflare; no binding or `EMAIL_PROVIDER=resend` → Resend (`auth-email-sender-base.ts:67-71`). Switching is a binding, not a redesign.
- ✅ **The gating shape exists.** `packages/auth/vitest.config.js` already uses the opt-out flag `LUMENIZE_NO_CF_REMOTE`, set only by the secret-less Claude-hosted lane, with a loud warning when coverage is dropped. Copy that shape; do not invent a new one.
- **Why Nebula went all-Resend originally:** reaching CF email via its **REST API** needs a highly-privileged CF key, stored plaintext in hosted environments — a far bigger blast radius than Resend's email-only key. That argument is about the **REST** path and hosted envs; it does **not** apply to a local binding authed by OAuth, which is what this task is testing.

## Relationships
- **Closes** the backlog item "Switch local Nebula test email from Resend to Cloudflare" as **not worth doing** — its premise was the false latency gap.
- **Corrected** ADR-009's cost line (factual only — the decision stands; rung-2's *rationale* is flagged open for Larry).
- **Resolves** the standing OPEN question in the `cf-email-sending-vs-routing` memory: the CF send binding **does** require `remote: true`.
- Feeds `testing.md` § Philosophy with the number its "measure before assuming" bullet asks for: **~1.4 s standalone, ~0.9 s marginal.**
