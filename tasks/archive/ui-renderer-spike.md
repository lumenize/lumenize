# UI Renderer Spike — Validate JurisJS ObjectDOM viability

**Status**: Complete (2026-05-12) — outcome below; LLM-generation experiment not run, decision reached via empirical recursion finding + design comparison.
**Workflow**: Docs-first — the system-prompt context drafted here *is* the API surface (it teaches the rendering paradigm that LLMs will generate against)
**Companion docs**: `website/docs/nebula/coding-your-ui.md` (paused; gets rewritten based on spike outcome), `tasks/nebula-frontend.md` (paused for same reason)

## Goal

Determine whether JurisJS ObjectDOM is a viable rendering paradigm for Studio-generated UIs, given the LLM training-data asymmetry vs Alpine-flavored alternatives. Produce a yes/no decision plus, if yes, the reusable system-prompt context for Studio.

## Background

The 2026-05-09 decision to adopt Alpine-flavored `x-*` directives (instead of porting JurisJS's renderer + component system) was made on training-data grounds — LLMs have heavy exposure to Alpine syntax; ObjectDOM is JurisJS-docs-only. The decision implicitly assumed:

1. Static-mostly UIs would dominate
2. The expressiveness gap of "no components" wouldn't bite
3. LLM-generation friction with ObjectDOM would be unbridgeable

Doc drafting through 2026-05-11 surfaced the components/recursion gap on the DAGTree case — the canonical DaisyUI-styled tree component at `/Users/larry/Projects/app/src/lib/components/DAGTree.svelte` uses recursive Svelte snippets, and our Alpine-flavored directives can't express that without significant additions. The "flat-list-with-depth" workaround loses DaisyUI's `menu-dropdown` styling parity.

Cost recalculation 2026-05-12:

- **Alpine path** (all unbuilt, all designed-from-scratch): ~750-1000 LOC, plus unresolved components design
- **Juris path** (mostly mechanical port of battle-tested code): ~1,895 LOC, components included

The 2x LOC overhead of Juris buys components for free, recursion for free, real reactivity for free, and zero design risk (it works in production today). The remaining concern is **LLM generation reliability with ObjectDOM**. This spike validates that one concern.

## Decision space (the spike must pick one)

The output is one of three commitments:

1. **Pure Juris** — port `DOMRenderer` + `ComponentManager` + `Juris` orchestrator. No `x-*` directives. Studio generates JS files describing ObjectDOM trees. Doc fully rewrites.
2. **Hybrid** — keep a small subset of `x-*` directives (e.g., `x-text`, `x-input`, `x-on:event`) for static-leaf markup; use Juris components for everything reusable/recursive/parameterized. Studio generates HTML + JS. Doc keeps the basics, rewrites the complex examples.
3. **Alpine + named-template recursion** — proceed with the Alpine-flavored design as planned, add `x-component` / `x-render` for limited recursion (~250-300 LOC more). No real components, no local state.

Lean going in: **pure Juris**. Validate before committing.

## Method

### 1. System-prompt context (the artifact this spike's "docs-first" produces)

A ~400-800 token system-prompt that teaches:

- ObjectDOM patterns (object-keys-are-tags, function-valued-slots-are-reactive, component-registration, recursion-via-self-reference)
- Lumenize-specific conventions (path-based state, `state.getState()` / `setState()` / `computed()`, the `resources.*` and `lmz.*` reserved prefixes, the synced-state middleware contract)
- Conflict resolver registration shape
- Auto-subscribe via reactive subscriptions (no explicit `client.resources.subscribe()` calls in user code)
- Bootstrap pattern: register components, mount root, done
- Component-local state via `newState(key, initial)`
- DaisyUI as the styling layer (CSS classes only; no framework-specific styling concerns)

Includes 2-3 worked examples in the system prompt itself (todo card with x-input equivalent, list rendering, modal). Designed to give an LLM enough to generate variants reliably.

**Lives in this task file** (next section) as the canonical draft. Graduates to wherever Studio's system prompts live if pure or hybrid wins.

### 2. Representative test prompts (4, UI-focused)

Each prompt is a natural-language description of a UI; the LLM should generate working code given the system-prompt context. Progressive — each step adds one capability. Resources-interaction is intentionally excluded — it works the same in both paradigms, so it's not discriminating. Prompts focus on the rendering paradigm itself.

1. **List rendering** — given an array of objects (e.g., `[{ id, name, status }, ...]` passed as a prop or held in local state), render each as a row in a list. Tests loop construction.
2. **Conditional rendering** — given a boolean state and two content variants, show one or the other based on the boolean. Bonus: a toggle button that flips the boolean. Tests conditional construction + a simple write-back.
3. **Reusable component with local state** — a "stat card" component takes a label and a value as props, plus maintains a local "expanded" toggle showing/hiding extra detail. Use the component 3 times on the page with different labels/values; each card's expanded state is independent. Tests components + props + local state.
4. **Tree with expand/collapse and search highlight** — recursive tree component matching the DaisyUI `menu` + `menu-dropdown` styling from [`/Users/larry/Projects/app/src/lib/components/DAGTree.svelte`](file:///Users/larry/Projects/app/src/lib/components/DAGTree.svelte). Each node has children; clicking the chevron toggles its expanded state (local per-node). A search input at the top, when populated, highlights matching node names (via `<mark>` or DaisyUI's `bg-warning` class) and auto-expands ancestors of matches. **The discriminating case** — exercises recursion, components, local state per instance, and content composition.

### 3. Scoring rubric

For each generation:

| Dimension | Score |
| --- | --- |
| Compiles / runs without errors | 0/1 |
| Idiomatic for the chosen paradigm (not awkward, not boilerplate-heavy) | 0-2 |
| Components / recursion expressed cleanly (single-use inlined, reusable factored out, self-reference for recursion — N/A scored as 2 on prompts that don't need it) | 0-2 |
| Reactivity model correct (function-valued slots for derived/reactive in Juris; directive correctness in Alpine) | 0-2 |

Max 7 per generation. Threshold for "Juris viable": **average 5+ across 4 prompts, with at least 3 prompts producing runnable code on first try, AND the tree prompt (#4) scoring 5+**.

The tree prompt has a floor requirement because it's the discriminating case — even if the simpler prompts pass, a weak tree result means components/recursion isn't reliably generable.

### 4. Decision criteria

| Result | Decision |
| --- | --- |
| Avg ≥5, ≥3 runnable, tree ≥5 | **Pure Juris** — commit. Begin port. Rewrite docs. |
| Avg 3-5, ≥2 runnable, tree 3-5 | **Hybrid** — Juris components + limited x-* directives. Smaller surface; bridge the LLM-friction gap with directive sprinkles. |
| Avg <3, OR tree <3 | **Alpine + named-template recursion** — Juris is too high-friction for reliable generation. Commit to the existing direction, add minimal recursion support, accept the components limitation. |

## Phases

### Phase 1 — Draft the system-prompt context

- [ ] Draft the ObjectDOM + Lumenize-conventions system prompt (~400-800 tokens)
- [ ] Embed 2-3 worked examples in the prompt
- [ ] Review for completeness — does it cover everything an LLM would need to generate the 4 test prompts?

### Phase 2 — Run the generation tests

- [ ] For each of the 4 prompts, generate with the system-prompt context active
- [ ] Capture each output verbatim
- [ ] Note generation friction (had to retry? confused on what?)

### Phase 3 — Score and decide

- [ ] Score each generation against the rubric
- [ ] Aggregate to a single decision per the criteria table
- [ ] Document the decision in this task file's "Outcome" section (below; currently empty)

### Phase 4 — Impact assessment

If pure Juris or hybrid wins:

- [ ] Catalog impact on `website/docs/nebula/coding-your-ui.md` (which sections survive, which rewrite, which are entirely new)
- [ ] Catalog impact on `tasks/nebula-frontend.md` (Decisions table, Surface section, Phase 5.3.6, for-docs tests)
- [ ] Update memory accordingly

If Alpine + named-template recursion wins:

- [ ] Design the `x-component` / `x-render` syntax
- [ ] Add to `tasks/nebula-frontend.md` Surface section
- [ ] Update `coding-your-ui.md` with the tree example using the new directives

## Outcome

**Decision: extend the Alpine-flavored grammar with components & recursion. Do not port Juris ObjectDOM.**

The LLM-generation experiment (Phases 2-3) was not run. Two findings during Phase 1 background research made the experiment unnecessary by changing the question the spike was answering:

### Finding 1: Juris's recursion guard blocks pre-populated trees on initial render

Verified empirically by running `demos/juris_composition_demo.html` (stock Juris from main) plus an instrumented `Juris` instance in Claude Preview. The relevant code is `DOMRenderer.#renderComponent` ([src/juris.js:1413](https://github.com/jurisjs/juris/blob/main/src/juris.js#L1413)):

```js
if (this.componentStack.includes(tagName)) {
    return this.#createErrorElement('recursion', ...);
}
this.componentStack.push(tagName);
// ... componentManager.create() runs synchronously ...
this.componentStack.pop();
```

The stack is pushed and popped synchronously around `componentManager.create()`. A component returning `{ children: [{ TreeNode: ... }, ...] }` renders its children inside the outer `create()` frame, where `componentStack` still includes the outer component's name. The inner same-name render hits the guard and emits an error element.

The dual-name workaround (`TreeNode` → `TreeNodeChildren` → `TreeNode`) buys one extra level but breaks at depth 2 because the chain re-hits the alternating name. Confirmed with an in-page test (3-level tree: only L0, L1a, L1b rendered; L2a, L2b were missing and a recursion error element appeared).

The published composition demo works because it stores tree shape in state, starts with empty roots, and lets `setState` mutations trigger deferred re-renders outside the original `create()` frame. That works but constrains the data model to "tree shape lives in state; props are seed-only" — non-obvious and not what an LLM trained on React/Vue/Svelte recursive components would produce.

In our port, the guard would be replaced with a depth cap (~5 lines of code). But this moved the cost-benefit framing from "mostly mechanical port" toward "port and modify," and weakened the "components and recursion for free" argument.

### Finding 2: Juris's reactivity-binding model is path-string-not-live-object

Reactivity in Juris fires when `getState(path)` is called inside a tracked function. Reading `node.isOpen` from a prop object does not trigger anything — the prop is a frozen-at-call-time JS value. The idiomatic Juris pattern is to pass IDs as props and call `ctx.getState(\`...\${id}...\`)` for every reactive read. Juris's own AI guide and the composition demo both elide this — they use closure-captured `props.id` style access, which works for one-level components but creates subtle reactivity gaps in nested trees.

Teaching this pattern to an LLM is more lift than initially credited. Most React/Vue/Svelte training data shows objects-as-props with property-keyed reactivity (Proxy-based). The Juris idiom — passing IDs, reading via `getState` — is alien enough that LLMs would need explicit, repeated teaching and would still produce subtly broken code.

### Why "Alpine + components" wins on the updated cost-benefit

- **Path-based reactivity coherence end-to-end.** State store, directive bindings, and synced-state middleware all key on paths. No translation layer.
- **No JS for the rendering paradigm.** Components are `<template>` tags; recursion is `x-render="own-name"`; per-instance state is `$local`. Vibe coders never write a render function.
- **LLM-canonical Alpine syntax.** `x-*` directives are the most-trained-on directive vocabulary. Components and recursion sit on top as Alpine-shaped extensions.
- **No fork-and-maintain risk.** We write our own crawler; no upstream coupling.
- **LOC**: ~510 from scratch (`@lumenize/ui`) vs ~1,895 port-with-modifications (Juris). Even with "from scratch" risk priced in, the gap holds.

### Surface added

- `x-component="name"` — define a component template
- `x-render="name"` — instantiate
- `x-prop:{name}="value"` — pass scoped values as props
- `x-key-from="..."` — derive instance discriminator (required when `$local` is used)
- `$local` — per-instance state proxy (get / set); mapped to `ui.{componentName}.{instanceKey}.*`
- `$trail` — read-only array of ancestor scoped values, auto-built during recursive descent, used for `instanceKey` disambiguation under multi-parent rendering
- Handler scope-injection: handlers receive `(event, scope)` with destructurable `{ $local, $node, $trail, ... }`

Canonical doc: [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — "Components and recursion" + "Worked example: DAG tree with virtual branches".

Decisions table row added to [tasks/nebula-frontend.md](nebula-frontend.md).

### What carries forward from this spike

- The 4 test prompts and rubric **become a Studio evaluation suite** rather than a spike artifact. When Studio's prompt assembly is being tuned, these are still useful inputs.
- The `$local` mechanism is borrowed-in-spirit from JurisJS's `newState`, but with path-keyed storage (matches Lumenize) rather than closure-captured getters/setters.
- The recursion behavior is intentionally permissive: no name-based guard, depth bounded by the JS call stack only. Matches React/Vue/Svelte and aligns with LLM expectations.

### Archive plan

Once the components & recursion implementation lands in `@lumenize/ui` and is validated against the worked tree example, move this file to `tasks/archive/`.

## System-prompt context (draft)

*[To be filled in during Phase 1]*

## Generation outputs

*[To be filled in during Phase 2]*

## Open questions

1. **Hybrid boundary**, if hybrid wins: which directives survive (`x-text`, `x-input`, `x-on:event`)? And what's the rule for "when do I use a directive vs a component"? Probably: "leaf markup with direct path binding → directive; anything parameterized, reusable, recursive, or with local state → component." Validate during the spike.
2. **Component-local state model**, if Juris wins: keep JurisJS's `newState(key, initial)` mapping to `##local.{compId}.{key}` paths verbatim, or rename/restructure for Lumenize conventions? Lean keep-as-is initially; refactor if friction surfaces.
3. **System-prompt distribution**, if Juris wins: where does the production version of this prompt live? Studio's prompt assembly will pull from somewhere — does the renderer prompt go in `apps/nebula/src/studio/prompts/`? In a `@lumenize/studio-prompts` package? Decide during Phase 4.
4. **LLM-as-evaluator caveat**: Claude generating AND scoring is methodologically weak. If the spike's results are borderline, consider a second pass with a different model or human review. For clear results (well above or below threshold), single-model evaluation is probably sufficient.

## Notes

- Spike output graduates to long-lived artifacts: the system-prompt context (if pure or hybrid wins) becomes part of Studio's prompt assembly; the decision becomes a Decisions row in `nebula-frontend.md`; the test prompts become the seed of an evaluation suite for Studio's prompt-engineering work.
- Time-box: 2-3 days of effort. Beyond that, the spike has failed at producing a clean signal and we should escalate (try a different model, bring in human review, or commit to a default).
- Per CLAUDE.md "Experiments" guidance, this is a *task-flavored* spike not a *code-flavored* one — no `experiments/<name>/` directory needed. The artifacts live inside this task file until they graduate.
