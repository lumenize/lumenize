# Decision/Research record — Studio codegen viability probe (Kimi 2.7)

**Archived / frozen 2026-06-22.** Point-in-time research record, extracted from
`tasks/nebula-agentic-development-engine.md` when that file was consolidated into
design + roadmap. **Do not update** (archive convention — frozen on entry). The
load-bearing lessons live on (compressed) in the engine doc's design section; this is
the full probe record.

---

## Viability verdict — PROVEN 2026-06-16

Kimi 2.7 UI-gen is **viable** (probe `apps/nebula/spike/sfc-devstar-loop/`, three stages
green; not-for-hand-review spike). Given `coding-your-ui.md` + the current ontology + the
Nebula API `.d.ts` as context, Kimi produced a **compilable** `App.vue` + `ontology.d.ts`
first-shot and **self-corrected in ~2 rounds**.

- **Model fact:** slug `@cf/moonshotai/kimi-k2.7-code` on Workers AI; **OpenAI-style**
  response shape (`result.choices[0].message.content`, not `result.response`).
- **Got right unprompted:** auto-subscribe `store.resources.<rt>[id].value` paths;
  `import { store, client } from './nebula'`; per-user `client.claims.sub` keying;
  container-resource id-list pattern; `v-model` guarded by `v-if`; client-side `computed`
  aggregates; atomic create-+-append in one `transaction`; DaisyUI throughout.
- **The one real bug:** Kimi invented `op: 'set'` (real vocab is `create`/`put`) — a runtime
  API-contract error compile can't catch. This is exactly why we **feed the real Nebula API
  `.d.ts`** as context and **wire an error-tail** for self-correction. A prompt-completeness
  gap, not a capability gap.
- **Loop lessons:** use **native tool-calling**, not regex-on-prose (`finish_reason:
  tool_calls` verified on Kimi); feed the real `.d.ts`; wire a real error-tail
  (`get_recent_errors` / debug-tail). **Caveat:** runs vary run-to-run — this verdict is
  directional, not statistical (the rigorous regression suite is the eval suite).
- **Substrate facts:** native tool-calling means **no sandbox** (no LLM-authored code runs
  server-side); `@cloudflare/codemode` is standalone but JSON-only (dropped, ADR-002); DO
  facets are independent of dynamic workers (a loader is only needed for a *runtime-generated*
  facet class).

> The spike's *implementation* plan (in-DO `DevStar.compileSFC`, files-as-resources, in-DO
> `tsc`, `register_ontology_version`) is **superseded** by `nebula-dev-flows.md` — vite owns
> SFC compile in the DevContainer (Decisions 2/9). Only the **verdict + lessons** survive.
