# Nebula Pre-Alpha Fast-Follow

**Status**: Drafted, not started — queued behind the mesh continuation-only work and the pre-alpha resume. Not a build commitment yet; `/review-task` before "go" on either item.
**Provenance**: Both items surfaced 2026-07-02 from the first user-developer spec — Jennifer's [Luminize Almanac vision/requirements/data-model](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit) and her companion [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit). Review lens was "what does this spec teach Nebula," not spec QA (see the `nebula-pitch-deck` memory for the full findings).

## Objective

Close the two platform gaps that stand between the current live loop and the first real user-developer app existing at all.

## Item 1: User-app media storage (photos/blobs)

**Goal**: A user-developer's generated app can accept, store, and serve end-user-uploaded media (photos first), governed by the same ReBAC/DAG access control as every other resource.

**Why now-ish**: The Almanac's atomic unit (`Entry`) *requires* one or more photos — the app cannot exist without this. Media is likely table stakes for a large share of domain-expert apps (the persona thinks in photos, documents, and artifacts, not rows).

**Shape (to be designed, not pinned)**:
- R2-backed blob storage surfaced as a platform capability, not raw R2 access (homogeneity: no per-app infrastructure divergence).
- Access control must ride the existing substrate — a photo is only readable by users who can read the resource that owns it (the sharing-circle semantics in Jennifer's spec map directly onto ReBAC).
- Relationship to `resource-history-r2` outbox mechanics: same bucket family, different object class — check for shared plumbing before designing fresh.

**Success criteria (sketch)**:
- [ ] A generated app can round-trip an end-user photo upload → store → display.
- [ ] An end user who lacks read permission on the owning resource cannot fetch the photo (direct URL included).
- [ ] No per-app R2 configuration — the capability is uniform across all apps.

## Item 2: App-branded AI persona

**Goal**: The built-in end-user AI chat is presentable as *the app's own assistant* — per-app name, tone, and behavioral constraints — while remaining the same ReBAC-governed chat underneath (the "can never read what the asking user can't read" guarantee is untouched and non-overridable).

**Why now-ish**: Jennifer named her app's AI layer ("Gigi Kaizen") *unprompted, in her first spec* — user-developers evidently think of the embedded AI as part of their product, not as Nebula's chat. Her spec also imposed behavioral values on it ("always gentle, never interruptive; no urgency language; no gamification") — tone/values constraints, not features.

**Shape (to be designed, not pinned)**:
- Per-app persona config: display name, voice/tone guidance, values constraints — data the platform's chat consumes, not code the app injects (no prompt-injection surface into the governed chat; constraints are additive style, never access-expanding).
- Never surface the underlying model name (existing rule: model-agnostic naming).

**Success criteria (sketch)**:
- [ ] A user-developer can name and style their app's assistant from the Studio.
- [ ] Persona config cannot widen data access or override platform-level chat guards (capable-of-failing test: a persona instruction attempting to read out-of-scope data does nothing).
- [ ] Behavioral constraints from the spec (tone, no-gamification-style rules) demonstrably shape chat output.

## Notes

- Third finding from the same analysis — **cross-document spec-drift detection** (Jennifer's two docs contradict each other: photo-first-required vs text-first capture) — is deliberately *not* an item here: it's a Studio/coach-loop capability question that needs its own framing, and the coach loop covers it manually during alpha. Revisit when the Studio eval suite resumes.
- Neither item jumps the queue: mesh continuation-only work remains the sole active branch work.
