# Claude autonomous iterate-loop (Exploratory — mechanism TBD)

**Status: ON HOLD — the north-star, deferred until the [live self-verification harness](../archive/claude-live-verification.md) (its driver + inspection client) exists.** Split out of that file in Stage-1 framing (2026-07-05, finding S2): the harness ships a *driver + inspection client*; this file holds the *speculative autonomy vision* it builds toward, so the active task stays honestly scoped.

## The vision (Larry, 2026-07-05)

> "Give a really high-level goal, like *make this work like the chat in Claude Code. Identify missing framework capability to propose to me. Don't force-fit it onto existing capability. However, go as far as you can without that capability and no force-fitting.* — and have you iterate on it for a long period."

Claude iterates **drive → observe → fix → re-drive** in a long-running loop against a live Nebula, using the harness as the feedback organ, surfacing missing framework capability as **proposals** rather than contorting Nebula around gaps.

## Deferred pieces (Exploratory — no acceptance pinned; these are spikes, not specs)

- **Long background iterate-loops** — sustained unattended drive/observe/fix cycles (prior-art: the harness's driver + `run_in_background`; a loop controller TBD).
- **act-as synthetic users** — act as provisioned synthetic subjects to exercise multi-user flows from one identity (builds on `delegated-token` + the Phase-3 `*` reach).
- **The "name the missing capability" proposal format** — a structured output for "here's the wall I hit, here's the framework capability I propose, here's how far I got without it."

## Un-park when

The harness's Phases 1–3 (identity, standalone driver, inspection client, prod/`*` reach) are built and the self-check-before-done practice is in routine use — i.e., the feedback organ is reliable enough to run a loop on. Until then this is premature.

## Deliverable shape (when un-parked)
Per `tasks/README.md` §multi-version/exploratory: capable-of-failing checks for the discovered loop behavior **plus** a captured-findings note — not a transcribable spec.
