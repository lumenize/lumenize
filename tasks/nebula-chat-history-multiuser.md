# Studio chat — durable, multi-user, reactive thread (history UI wiring + participant model)

**Status**: Draft — ready for `/review-task`. The ONE active child of [nebula-pre-alpha.md](nebula-pre-alpha.md) (§ Invite-gated → "Chat history UI wiring"). On completion: extract nuggets up into the master + archive this file.

## Objective (target, present tense)
The Studio chat is a **durable, multi-user, reactive** thread. Every **human** turn AND the AI (Nebula) reply persist as `Message` Resources on the DevStudio DO; the SPA renders the thread by **subscribing** to them, so **reload / reconnect / multi-tab / a second participant** all restore + stay live. Each `Message` carries a stable **`author` (a `sub`)**; the sender's display name is **resolved from a participant roster** (email for humans now, "Nebula" for the agent) — never stored on the Message. This also completes the `Message` substrate that **THE GATE (capture-live) rides on** — durable, author-attributed turns are what make "what did each user ask?" capturable.

## Why now / context (grounded 2026-07-06)
- **Capability shipped, UI never wired.** The backend persists a durable assistant `Message` (`DevStudio.commitAssistantMessage`) + exposes the query sub `Message where session == DEFAULT_SESSION_ID`; the client SDK exposes `client.resources.subscribe`. But `nebula-studio-ui/src/App.vue` keeps chat in a **local in-memory array** (`type Msg`, App.vue:23-24) and never subscribes → reload/reconnect/multi-tab start empty.
- **The user's turn is NOT persisted.** `DevStudio.chat` commits only the assistant `Message`; the human prompt goes into the model call (`dev-studio.ts:822 userMessage`) but is **never** committed as a `Message`. Confirmed by code + reproduced live 2026-07-05 (`/live studio-chat-reload`: the submitted turn triggers codegen but **never renders in the thread, before OR after reload**).
- **NEW design driver (Larry, 2026-07-06): single-user+AI → MULTI-user+AI.** Multiple humans (Universe admin, invited collaborators, or Larry via impersonation) share one Studio chat session with the AI → a **participant model** (below). Not previously captured in the master (which covered multi-user *apps*, not the *Studio chat*).
- **Substrate already exists:** `DEFAULT_SESSION_ID` is a single fixed session (chat-constants.ts) and Child-2 `QuerySubs` already does the `Message where session==…` sub with per-push read recheck (`accessAdmin`) + windowed lazy content. So multi-user = many participants on the one fixed session; the missing pieces are (a) durable **user** Messages, (b) the **participant model** (`author`, resolution), (c) the SPA **subscribe + render**.
- Aligns with [[nebula-prefer-subscribe-for-live-ui-data]]: shared/live chat → `subscribe` (syncs tabs AND users), never one-shot `call()`s.

## Participant model (settled — the core design, nailed with Larry 2026-07-06)
`/review-task` pins mechanics, not the model.

- **`author = sub`** — a stable participant id on every `Message`. A human's real auth `sub`; **Nebula's own reserved constant `sub`** (a fixed UUID, like `DEFAULT_SESSION_ID`; **NOT** a nebula-auth `Subject` — it never authenticates, so a real subject would just be a permanently-dangling account). One id-space, one field, human or agent.
- **No `role` field.** `role: user|assistant` conflated *who you are* (human vs agent) with *what you can do* (capabilities) — split them. `role` is dropped; "assistant" is gone (it also clashes with human employees who *assist*).
- **`Participant { sub, kind: 'human' | 'agent', name }`, resolved from the session — NEVER denormalized onto Messages.** Emails change; keying display off an email frozen into immutable history is wrong (Larry). Human `name` resolves from auth (`sub → email` now; a friendly-name/profile store later returns friendly names and **all history lights up with no backfill** — the whole reason to resolve, not store). Agent entries (Nebula) are static roster entries.
- **Capabilities uniform at the API, gated in the UI.** Streaming thinking and other agent affordances are things any author *could* emit; the UI only surfaces them for `agent` participants (humans never get the option). So the model records `author` + `content` (+ an optional thinking payload), never a capability role.
- **Author stamping — the asymmetry is correct, not a smell:**
  - **Human turn** → `author = callContext.originAuth.sub`. The human is a genuine remote authenticated origin, so the mesh machinery is already exercised and we *validate an untrusted cross-boundary claim*.
  - **Nebula turn** → `commitAssistantMessage` stamps `author = NEBULA_SUB` **directly, first-party**. DevStudio *is* Nebula; there's no untrusted boundary, so the server-authoritative property is *stronger* here (no client in the loop). Routing this through auth machinery would mean minting Nebula a JWT and originating a self-call as a client to obtain an identity we already are — ceremony, zero validation value.
- **History is append-only** (ADR-004) — Messages are immutable snapshots; resolving names live (not storing them) keeps old turns correct as emails/names change.

## Deferred generalization (fenced — do NOT read the shortcut as the model)
The **general** target is that *every* agent — Nebula and any future one (e.g. a **Claude Code bridge**) — participates through the **same** uniform, mesh-authenticated path. That generalization has three layers with very different costs; build the cheap general layer now, fence the rest:

1. **Data + participant model** *(general NOW — ~zero extra cost)*: `author = sub`, `Participant {kind}`, no `role`, roster resolution. A future external agent slots in as another participant with **no schema/model change**.
2. **Write mechanism** *(contained shortcut for the primary Nebula)*: first-party in-DO direct-stamp vs a mesh-authenticated post from a remote origin. Diverges only here; converging later is a localized change, not a data migration.
3. **Agent capability surface** *(DEFERRED — high cost + speculative)*: exposing `writeSource` / Workspace commit / preview-push as **participant-facing mesh operations** + the authorization model for "which participant may do them." No consumer to pin it against today. **Trigger to build it = the first EXTERNAL agent** (a Claude Code bridge can't use the in-DO shortcut — it *forces* this layer). When that lands, Nebula may migrate onto the general write path (layer 2) or not, with **no model change** (layer 1 was general from the start). Nebula's direct-stamp is a **fenced shortcut, not the intended end state.**

## Open questions (pin at `/review-task`)
1. **Nebula's reserved `sub` shape** — a reserved UUID (uniform with human subs, opaque, roster says it's Nebula) vs a self-describing `agent:nebula` id (breaks UUID-uniformity but readable in logs). Lean reserved UUID.
2. **Roster sourcing** — derive the human participant set from existing scope membership/grants (ADR-008 makes org structure visible within a Star, so "who's in this chat" may already be enumerable client-side) vs a maintained `Participant` resource set updated as people post. Lean derive-from-grants if already client-visible; else a lightweight roster resource.
3. **Transient-stream reconciliation** — the assistant id is minted up front + streamed via `svc.broadcast` (Child-3 option (b)); the durable Message lands at completion. Confirm the SPA dedupes the streamed animation into the committed Message by id, and add the same for the new user Message.
4. **Windowing/grace reuse** — reuse Child-2's windowed lazy content subs + grace for the thread sub (a long history shouldn't load all content at once).

## Phases

### Phase 1 — Durable Messages + `author = sub` + participant resolution (backend)
**Goal**: every turn (human + Nebula) persists as an author-attributed `Message`; the client can resolve `author → {kind, name}`.
**Success Criteria**:
- [ ] `Message` ontology (`apps/nebula/src/devstudio-resource-ontology.ts`) gains `author` (a `sub`); **`role` is removed.**
- [ ] `DevStudio.chat` commits a durable **user** `Message` `{ session, author: callContext.originAuth.sub, content }` at turn start (after `ensureSession`); `commitAssistantMessage` stamps `author = NEBULA_SUB` (reserved constant).
- [ ] **Server-authoritative human author**: a chat call that tries to set a *different* author is committed with the caller's real `originAuth.sub`, not the supplied one (capable-of-failing: a spoof landing the wrong author must red). Nebula's author is a server constant (unforgeable by construction).
- [ ] Participant resolution exists: `author → { kind:'human'|'agent', name }` (human name = email via auth; `NEBULA_SUB → {agent, "Nebula"}`). Source per Q2.
- [ ] The `Message where session==DEFAULT_SESSION_ID` query sub emits BOTH turns of an exchange. Capable-of-failing vitest (pre-fix: no durable user Message → reds).

### Phase 2 — Reactive multi-user thread: subscribe + render by participant (SPA)
**Goal**: the thread renders from a live subscription; reload/reconnect/multi-tab/second-participant all work; each turn shows its author's resolved name.
**Success Criteria**:
- [ ] `App.vue` replaces the local `messages` array with a live `client.resources.subscribe` to the session's Messages (reuse Child-2 windowing/grace); mount/reload/reconnect **restore from the subscription**.
- [ ] Each Message renders by its author's **`kind`** (human vs agent — agent gets Nebula's affordances like the thinking disclosure), labeled with the **resolved name** (email for humans now, "Nebula" for the agent). The user's own turn renders immediately (posted durably per Phase 1).
- [ ] **Multi-user**: a *second* identity posting to the same session appears **live** in the first participant's thread, labeled with its resolved name. (`/live` with two identities — the second via a minted/impersonated token.)
- [ ] Capable-of-failing `/live studio-chat-reload`: the turn renders AND **survives reload** (pre-fix empty-after-reload must red).

### Phase 3 — Reconcile the transient stream + retire the ephemeral path
**Goal**: no duplicate/orphan messages; the "thinking" animation resolves into the durable Message; dead code gone.
**Success Criteria**:
- [ ] The ephemeral `svc.broadcast` progress stream dedupes into the durable assistant `Message` by id (and the new user Message); the streamed animation resolves into the committed turn — no doubles.
- [ ] The ephemeral `onChatResult` local-array path is removed (master's still-open Child-3 deferral).
- [ ] Capable-of-failing dedup test (a streamed-then-committed turn must not render twice).

## Multi-user / security / impersonation notes
- **Authorization unchanged** — post/subscribe is DAG-gated per-push (Child-2 `accessAdmin` recheck under `SESSION_NODE_ID = ROOT_NODE_ID`). Multi-user works because all participants with access to the scope's DevStudio share the one session.
- **Impersonation**: a delegated token keys off `sub` not `act`, so when Larry impersonates a synthetic user, `callContext.originAuth.sub` = the impersonated user and that's the `author` — resolved to the synthetic `@example.com` label via the roster (per the master's synthetic-user caveat). Correct for exercising multi-user.
- **Feeds THE GATE**: capture reads these Messages; author-attributed *user* turns are the highest-value signal. Build this before/with THE GATE.

## Non-goals
- Friendly display names / profiles / avatars — deferred; names resolve to email for humans, "Nebula" for the agent, until a profile store lands (then the roster returns friendly names, history unchanged).
- The **general agent capability surface** (`writeSource`/commit/preview-push as participant mesh ops) — deferred to the first external agent (see Deferred generalization).
- Presence / typing indicators / read receipts (later).
- Multi-**session** management UI (D4 — `DEFAULT_SESSION_ID` stays the single fixed session).
- The offline replay harness (Wave 2) — consumes these turns later.

## Files
- `apps/nebula/src/devstudio-resource-ontology.ts` — `Message` type (add `author`, **remove `role`**).
- `apps/nebula/src/dev-studio.ts` — commit the user `Message` (author from `callContext.originAuth`) + Nebula reserved-sub stamp in `commitAssistantMessage` (~L369-421, L567); define/import `NEBULA_SUB`.
- Participant resolution — location per Q2 (derive from grants, or a small roster resource near the Session).
- `apps/nebula-studio-ui/src/App.vue` — subscribe + render by participant kind + resolved name (replaces `messages`; own email at `client.claims.email`, L315).
- `apps/nebula/src/frontend/create-nebula-client.ts` — confirm the subscribe surface covers the thread.
- `apps/nebula/src/chat-constants.ts` — `DEFAULT_SESSION_ID` / `SESSION_NODE_ID` (reference) — likely home for `NEBULA_SUB`.

## Verification
- **`/live studio-chat-reload`** extended for multi-user (two identities on one session) — the runtime proof (renders + survives reload + second participant appears live). Reuses the harness scenario shipped this session.
- **Capable-of-failing vitest** for Phase 1 (durable user Message + server-authoritative author, spoof-rejected) and Phase 3 (dedup). Per testing.md: each must red against the pre-fix code.
