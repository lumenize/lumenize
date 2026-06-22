# Nebula Studio — what's next (candidates + iteration mode)

**Status**: first-stab planning doc, written 2026-06-22 at the end of a long build session
(context running low — drafted here to continue in a fresh context). The Studio **dev loop
works end-to-end** on real infra (`wrangler dev` + Docker Desktop): describe → model
generates → source pushed → preview updates, with a visible "thinking → thought process"
view. Commits on `feat/nebula-studio`: `b997f2d` (version contract + first assembled run),
`f52da5b` (Studio UI + chat stub), `545f4e3` (codegen engine — model-driven + thought view).

**What works:** real model (`@cf/moonshotai/kimi-k2.7-code` via Workers AI — id isolated to
one swappable `STUDIO_MODEL` const; never surfaced in UI) generates **self-contained Vue
SFCs** (local state only) from a chat prompt; follow-up edits work; the thought-process
panel shows reasoning + output.

**What's NOT done (by design — the minimal prompt forbids it):** generated apps **don't use
the Nebula backend** (ontology + Resources + client/store). That's the next frontier.

> **Refs:** codegen design = [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md)
> (rough/unreviewed) · parked eval suite = [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md)
> · parked skills = [`on-hold/nebula-skills.md`](on-hold/nebula-skills.md) · architecture =
> [`nebula-dev-flows.md`](nebula-dev-flows.md). Memory: `studio-model-agnostic-naming`,
> `preview-path-prefix-vite-base`.

---

## The decision to make (next context)
**What to work on next, and the right iteration mode for it.** The two top contenders are
the real system prompt (B) and the recording/analysis tooling that makes iterating it
efficient (A). Larry's instinct (this session): **do the tooling first so the prompt work
can iterate independently** ("some way to record prompts and responses so you can analyze
them"). This doc agrees — see the recommendation.

---

## Candidates

### A. Codegen recording + prompt-iteration harness  ← *recommended first*
A way to **capture every codegen turn** (system prompt, user message, current source, model
output incl. `reasoning_content`, applied/error) **and re-run `(systemPrompt, message) →
model → output` independently** — so prompt iteration doesn't require a human driving the
browser each turn.
- **Why first:** the prompt work (B) is empirical — try → observe → refine. A human-in-the-
  browser loop per iteration is slow; a harness lets the prompt be iterated fast and
  independently, and starts the data needed for the eval suite (C).
- **Iteration mode:** *transcription* to build (a defined harness), then it *enables* B's
  exploratory mode.
- **Open design Q (resolve first):** how to run codegen independently of the browser. To
  iterate the **prompt** you only need the *model* call (`env.AI.run(prompt, message)`), NOT
  the full container/preview loop — so a lightweight harness can run without a container
  (a vitest-pool-workers test or script against the `AI` binding / Workers AI REST), capture
  outputs, and let analysis happen offline. Capturing **full real turns** (incl. apply/render
  errors) still wants the live loop — so likely: (1) log every real `DevStudio.chat` turn to
  a store (D1/R2/debug-sink), AND (2) a prompt-only harness for fast offline iteration.
- **Relation to C:** this is the lightweight precursor to the parked eval suite.

### B. The real system prompt — data-bound generation  ← *the actual goal*
Make the model generate apps that **use the Nebula ontology + Resources + client/store**
(persistent, multi-user, secure-by-default), not local-state toys. Lives in
[`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md).
- **Why:** the product value. Local-state toys prove the loop; this proves the platform.
- **Iteration mode:** **exploratory** (empirical prompt iteration) — NOT a pinnable spec.
  Iterate via A (fast/independent) + occasional browser checks.
- **Depends on:** A (to iterate efficiently); the **container vite swc fix** (D — data-bound
  apps import the client factory, so the container's vite hits the same TC39-decorator issue
  the Studio UI did); and teaching the model the Nebula API (the **skills** —
  [`on-hold/nebula-skills.md`](on-hold/nebula-skills.md): base prompt / rules /
  progressively-disclosed skills; first sub-agent = product-alignment verifier).

### C. The codegen eval suite (parked)
The full regression suite — deterministic gates first (plain `expect()`), LLM-judge
(GLM-5.2, temp 0) only for fuzzy UI quality. [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md).
- **When:** after A + enough prompt iteration that there's something stable to regression-
  test. Grows out of A's captured data.

### D. Deferred DX / correctness items (smaller, transcription-ish)
- **Container vite swc** — *prerequisite for B's data-bound apps* (generated App.vue importing
  `{ client, store }` from `nebula.ts` → the container's vite needs `unplugin-swc`, like the
  Studio UI; + an image rebuild). Same fix as `preview-path-prefix-vite-base` neighbor.
- **HMR under the path prefix** — re-enable so the loop is sub-second (no full iframe reload
  per change). Disabled in the first cut; needs `clientPort`/path tuning (the WS path 101's
  cleanly, so it looks viable). Currently the Studio UI force-reloads the iframe each turn.
- **Real-time thought streaming** — upgrade the waiting→thought from after-completion to live
  token streaming (mesh chat-chunk channel + a client handler). DX nicety.
- **First `apps/nebula` deploy** — turn the deploy-gated `it.skip` e2es green on real infra
  (`nebula-release-process.md` intersects). The local loop works, so this isn't blocking.
- **Wrangler 4.86→4.103 + vitest-pool-workers bump** — own deliberate task; won't remove the
  Studio UI swc need (vite/Oxc don't do TC39 decorators); mind the 2022-03↔2023-11 decorator
  iteration gap. Possibly broadens vitest-pool-workers coverage.

---

## First-stab recommendation (refine in the new context)
1. **Build A** (lightweight recording + a prompt-only harness) — resolve its open design Q
   first (prompt-only vs full-turn capture). This is the enabler.
2. **Then iterate B** (data-bound system prompt) using A, after landing the **container swc**
   prerequisite (D) and folding in the **skills** approach for teaching the Nebula API.
3. **C grows out of A**; the other **D** items slot in as needed (container-swc is a hard
   prereq for B; HMR/streaming are polish).

**Iteration-mode summary:** A and the D-items are *defined builds* (transcription; `/build-task`
fits). B is *exploratory* — fast empirical loops via A, not a spec to transcribe; treat its
phases as exploratory (capable-of-failing checks + captured findings, per the build-task
exploratory-phase rule).
