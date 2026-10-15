# A previewed build reaches every Studio on its app

**Status:** Built 2026-10-14/15, all five phases, through a verifier panel and a deployed pass (§ *Build notes*); the archive waits on Larry reading the retro. Drafted 2026-10-12; two Stage 1 passes and a Stage 2 pass ran on 2026-10-13, and Larry settled the decisions they raised (§ *Decisions*). It builds the part of [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)'s build version that Studio needs, absorbs fast-follow Item 8, and builds before personas, whose tab pacing runs on it.

## Objective

**A build lands on `.dev` only when the model previews it, and then every Studio open on the app reloads its preview onto it, at the URL the preview was showing.** The model previews a clean build by default and decides for one with type findings. Each page carries the build version it was served, and Studio learns which build landed from a resource it subscribes to, so a frame Studio asks to reload moves only if it is not already on that build.

After Jennifer changes the Save button's label and builds:

| Page | Today | After |
|---|---|---|
| Jennifer's Studio, which asked for the build | Its preview reloads, at the Star's root | Its preview reloads, at the URL it was showing |
| Austen's Studio, open on the same app | Keeps the old label until Austen asks for something, or comes back after 4 minutes away | Its preview reloads, at the URL it was showing |
| Either Studio, when the model held the build back for a type finding it judged real | Any frame that loads afterwards runs it anyway | Nothing anyone sees changes, and the reply says the preview was not updated |

A page outside Studio, such as a persona's host `mary--dev.crm.acme.lumenize.dev` in a tab of its own, keeps the code it loaded until it reloads; § *Relationships* says where its own check lands.

This task adds a reload Austen did not ask for. Jennifer's build now reloads Austen's preview, and the page loses whatever it held only in memory, such as a half-typed field or an open dialog, as ADR-024 § *Consequences* accepts.

## Context

**ADR-024 gave every page two versions, and only one of them works yet.** The ontology version works end to end: a build that changes the types reaches every page that holds a subscription, because the Star's install tells each of them ([nebula-star-ontology.md](archive/nebula-star-ontology.md)). The build version exists only as a digest the build job reports. So a build that changes only code reaches whoever asked for it, and a collaborator watching the same app keeps running code that no longer exists. The ADR's *Today's code differs* says exactly that.

**The model's call on the preview decides less than it was meant to.** On 2026-08-28 previewing became the model's call ([archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md)): a clean build is previewed by default, and the model decides for one with type findings, which still bundles because `vite build` does not type-check. But the Galaxy serves `.dev` straight from `dist/`, which every bundle overwrites, so a build the model held back is live the moment it arrives, and the call decides only whether the requester's preview reloads. Telling every Studio about every build on top of that would reload every Studio onto a build the model held back. So this task moves the word *land*: today a build lands when its bundle arrives, and after it a build lands on `.dev` when the model previews it.

**Personas is why now.** It puts several pages of one app on screen at once, a tab per persona in Studio and each persona also on its own host, and it paces their reloads after a build: the tab in view at once, each other loaded tab the next time it comes into view ([nebula-testing-with-personas.md](nebula-testing-with-personas.md) § *Decisions*). That pacing needs every Studio on the app to know which build landed. Fast-follow Item 8 already planned the first half, telling every Studio; this task takes it over.

The rest of this file says what each page needs, what exists, and the contract the phases build against.

## Goals

1. **A build is served on `.dev` only once the model previews it.** Today `#serveBuiltApp` serves `.dev` from `dist/`, which every bundle overwrites.
2. **Every Studio on an app hears every build that lands.** Today `announceBuildToRequester` pushes only to the client whose build it was, so Austen's preview keeps the old code until her own next request.
3. **Studio knows which build landed, and each frame decides by it.** Today Studio's `handlePreviewReady(scope)` carries only a scope, so nothing can tell a frame already on the new build from one that is not, which is the difference personas' pacing turns on.
4. **Studio's reload keeps the preview's URL.** Today `reloadPreview` points the frame at the Star's root.

## Relationships

- **Gated by nothing open.** ADR-024 is committed, and [nebula-star-ontology.md](archive/nebula-star-ontology.md) is built.
- **Gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md),** whose strip sends the reload request this task builds.
- **Absorbs [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 8: Tell the OTHER collaborators a new build landed*.** Its goal carries over. Its list of who has the app open, the chat query's subscribers, gives way to the Studios subscribed to `.dev`'s `ServedBuild`. Its two warnings, that a closed tab takes time to drop off the list and that nobody may have to remember to enrol, are answered in § *Decisions*.
- **Builds before [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md).** This task's landing passes `ensureResource` a server-composed `actor` and the pinned verdict. That file's § *What changes* removes the verdict's flag, `pinnedAtPost`, and its open questions take `actor`'s only caller to be the reply, so Phase 3 amends it to keep both, with the landing as their caller. Beyond those two, the tasks touch different parts of the same reply composition in `galaxy.ts`, `security.md`'s bullet on a turn's authority, and the scenarios `four-party-chat` and `first-app-built`.
- **Updates ADR-024 in a late phase.**
  - § *Decision* says a Galaxy's `.dev` Star runs its last successful build's ontology version; it comes to say its last previewed build's.
  - § *Today's code differs* comes to say every page carries its build version, and a build that changes only code reaches every Studio on the app.
  - § *Deliberately open*'s bullet on how a page learns its build is no longer current names, for `.dev`, the landing telling the pages its Star holds; it comes to say every Studio learns the landed build and reloads the frames it holds, and leaves open only a page in a tab of its own.
  - § *Deliberately open*'s bullet on pages served while a build's output is still arriving comes to say `.dev` serves only a copy made once a build is previewed, as a published Star serves only `dist-prod/`.
  - § *Consequences* promises the preview always runs what was just built; it comes to say the preview runs the last build the model previewed, and gains a negative line, that a held-back build is served nowhere until the model previews a build.
- **Changes every test and scenario that asserts the requester-only push,** as Phase 4 lists them.
- **Touches three rows of [backlog.md](backlog.md).** The `.draft` Star row in § *Nebula* is new; in § *Nebula Studio UI*, the row on reflecting `activeScope` in the URL gains the preview's own path, and Phase 4 builds the clearing half of the login-notice row.
- **Leaves Stars with real users, and every page outside Studio, to fast-follow, beside Mesh's durable outbox.** [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 5* owns how a page learns its build is stale on its own, and a publish copying `/dist-dev/` to `/dist-prod/`; § *Item 4* owns a reload keeping the page's unsaved writes; and [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 11: Durable calls* owns the outbox, which keeps a call in flight from a Client or a Durable Object across a restart of either.

## Current state

Built already, each with its fate:

- **The digest a build reports.** The job hashes `dist/index.html` into `bundle.indexSha256`, and `Galaxy.#distArrived` checks the arrived file against it. *Carried over:* it is the build version, and the `index.html` a landing copies to `/dist-dev/` hashes to it; the serve path adds the page's metas only when it serves the file.
- **The preview decision and the landing.** `decidePreview` previews a clean build by default, previews one with type findings only on the model's `{ "preview": true }`, previews nothing on `{ "preview": false }`, and never previews a failed bundle, which leaves the previous `dist/` in place. `decideLanding` lands a build whose bundle succeeded, whose `dist` arrived, and whose ontology compiled if it carried one, and `#land` then makes the compiled row the `.dev` Star's. `#buildAndLand` asks `decidePreview` only after landing, so it gates nothing but `announceBuildToRequester`. *Adapted:* one predicate decides whether a build lands on `.dev`.
- **The serve path.** `#serveBuiltApp` serves a `.dev` page from `/workspace/dist/` in the Galaxy's own storage, which the job's `vite build --emptyOutDir=false` writes in place and `#pruneDist` trims to the files the job reported. *Adapted:* `.dev` serves `/dist-dev/`.
- **The `nebula-scope` meta.** The serve path writes `dev`, `parentOrigin` and `ontologyVersion` into every HTML page. `createNebulaClient` reads `parentOrigin` from it itself (`parentOriginOfPage`), and the app's own `src/nebula.ts` reads `ontologyVersion` and passes it in. *Adapted:* it gains `buildVersion`, which `createNebulaClient` reads itself, since `src/nebula.ts` is seeded once per Workspace and the model may edit it.
- **The requester's push, end to end.** `announceBuildToRequester` hands the requester's address to `deliverPreviewReady`, a one-way call to `StudioClient.handlePreviewReady(scope)` whose `onErrorOnly` handler, `onPreviewReadyUndelivered`, logs a lost delivery. Studio's `onPreviewReady` hook then calls `reloadPreview`, which points the frame at the Star's root with a `?t=` cache-buster. *Left behind:* the subscription replaces every piece of it.
- **Subscriptions and writes on the plane.** A Client subscribes to a resource with `client.resources.subscribe` only once it exists, since `Subscriptions.subscribeResource` refuses an id with no snapshot. A query subscription answers with no rows at all, as Studio's on the chat, `Message where chat == DEFAULT_CHAT_ID`, does before the first message. Each write reaches the subscribed tabs and drops one its host reports gone, and `ClientResources.#restoreSubscriptions` subscribes again after a reconnect, which delivers the current value. The plane writes through `ensureResource`, which creates a resource if it is absent and otherwise does nothing, and `doTransaction`, which checks the live grant at commit; only `ensureResource` may take the server-composed `actor` and `pinnedAtPost` (`TransactionOpts`' JSDoc). *Adapted:* the landing becomes a second caller of `ensureResource` with `actor` and the pinned verdict, whose flag is renamed `pinnedAtDoor`.
- **The chat ontology.** The Galaxy's plane is typed by the platform chat ontology, `Chat` and `Message` in the precompiled seed `chat-message-v1` (`validator-seeds.ts`, generated by `scripts/gen-validator-seeds.ts` from `chat-constants.ts`), and no `Chat` resource is stored at `DEFAULT_CHAT_ID`, since `Galaxy.ensureChat` was deleted on 2026-09-21. *Adapted:* it gains `interface ServedBuild { chat: Chat; star: string; buildVersion: string }` and becomes `chat-message-v2`.
- **Studio's reloads of the frame.** `reloadPreview` has four callers: `onPreviewReady`, the Reload button, `wipe()` after the dev data is wiped, and `onVisibilityChange`, which reloads after more than 4 minutes hidden because a push could be missed and because a build another tab asked for sent this tab nothing. *Adapted,* as § *Design intent* says.
- **The page's reload hook.** `createNebulaClient` takes `onShouldRefreshUI(info: OntologyStaleInfo)`, which defaults to `window.location.reload()` and which an app may replace with a "new version available" banner (`api-reference.md`). `decideStale` and the `lmz.ontology-reloaded-for` key in `sessionStorage` call it at most once per ontology version in a tab, and today only an ontology change calls it. *Adapted:* it also takes a `BuildStaleInfo`, with a guard key of its own.
- **The frame's channel to Studio.** In a frame, `createNebulaClient` posts `{ type: 'lumenize:login-required' }` to the `parentOrigin` in its meta, and Studio's `onFrameMessage` shows it as `previewNotice`, which nothing clears. *Adapted,* as § *Design intent* says.
- **What the model reads about `preview`.** The build tool's description and its `preview` parameter, `TOOL_CONTRACT`'s line offering the override, `mark_complete`'s description, `decidePreview`'s `why` strings, `BuildReport.preview`'s JSDoc, `studio-guidance.md` § *Naming the model sees*, and the `define-ontology` skill's step 6, which says the preview runs the new types once the build lands. Beside them, two docs embedded as `.platform/docs/`: `api-reference.md`'s `onShouldRefreshUI` row describes only the ontology case, and `coding-your-ui.md`'s lifecycle line says a page on the old build reloads once when a new version of the app lands, which today holds only for a change of types. *Adapted:* each of the first group comes to say that a build the model does not preview is served nowhere. The `api-reference.md` row gains `BuildStaleInfo`, and the lifecycle line comes to say a page Studio frames reloads on any build, while a page outside Studio reloads on a change of types alone. `gen-platform.mjs` regenerates the embed.
- **The names and JSDocs that say only the requester hears a build.** Beyond the push itself: `#buildAndAnnounce`, which announces nothing once the push goes, and its JSDoc; `StudioClient`'s class JSDoc; and the comment above `onVisibilityChange`. *Left behind:* `#buildAndAnnounce` is renamed for what it does, queueing builds, and each comment comes to say every Studio subscribed to `.dev`'s `ServedBuild` hears every landing.
- **The reply a turn writes.** After the loop ends, the Galaxy commits the agent's `Message` with the model's reply and a thought panel whose last line names the turn's files and the last build's type findings. When the model wrote no reply and files changed, the Galaxy writes `Updated the preview.` in its place. Nothing in it says whether the last build landed, and `mark_complete` ends the turn without looking. *Adapted:* a turn whose last build was held back says so in the reply, and the fallback appears only when it landed.
- **`security.md`'s bullets on the chat floor and a turn's authority.** The first says a build that lands changes only the types the `.dev` Star runs, and the second that the reply commits under the verdict pinned at the post. *Adapted:* a landing also moves `.dev`'s served copy and its `ServedBuild`, which it writes under the same kind of pinned verdict.

## Design intent

- **One predicate decides whether a build lands on `.dev`, and the model's call is part of it.** `decideLanding` absorbs `decidePreview`: a build lands when its bundle succeeded, its `dist` arrived, its ontology compiled if it carried one, and it is previewed, which happens by default on a clean build, on the model's `{ "preview": true }` with type findings, and never on `{ "preview": false }`. A successful bundle that reports no `indexSha256` is held back too, since its arrival cannot be checked. The report's `preview` step is the landing's outcome, the row's check below included, so the model reads one reason, as `{ refreshed: false, why: 'type findings — held back, so .dev still serves the last previewed build' }`.
- **A landing runs in a fixed order, and a refused step lands nothing.**
  1. Read the compiled row and check its types hash to the version the job was asked for.
  2. Copy the build's assets from `/workspace/dist/` to `/dist-dev/`.
  3. Write `/dist-dev/index.html`.
  4. Store the row as the `.dev` Star's.
  5. Create `.dev`'s `ServedBuild` for this build.
  6. Remove stale files from `/dist-dev/`.

  A page served mid-copy gets one build or the other, never a mix, and the row follows `index.html` at once, so no page is served old code pinned at the new ontology version. A row that fails its check lands nothing, no copy and no `ServedBuild`, and the report's `preview` step says why. Step 5 creates a row at a fresh id under the verdict pinned at the door that admitted the build, so nothing after `.dev` moves can refuse it: there is no row to read, conflict with or find deleted, and no grant is checked. A build the model holds back stays in `/workspace/dist/`, which nothing serves; to preview it, the model builds again with `{ "preview": true }`.
- **`/dist-dev/` sits outside `/workspace`.** The model's tools resolve every path under `/workspace` (`assertModelPath`), git tracks only `/workspace`, and the container serves only that subtree, so none of them reaches what `.dev` serves. The exec's sync still pushes it into each build box, as it pushes any root-level write, so a landing copies only the files that are absent from `/dist-dev/` or whose bytes differ. The serve path reads it without the `/workspace` prefix.
- **A page's build version is the digest of the `index.html` it was served, and the Galaxy writes it into that page.** It goes in the `nebula-scope` meta beside `ontologyVersion`, as `<meta name="nebula-scope" content='{"dev":true,"parentOrigin":"https://crm.acme.lumenize.dev","ontologyVersion":"3f2a9c…","buildVersion":"9c41e0…"}'>`, computed from the `/dist-dev/index.html` the Galaxy is about to serve rather than stored, so it names exactly what the page received.
- **Studio learns the landed build from `.dev`'s `ServedBuild`, through a query.** Each landing creates a new `ServedBuild` at a fresh id, as `{ chat: DEFAULT_CHAT_ID, star: 'dev', buildVersion: '9c41e0…' }`, and Studio subscribes to `ServedBuild where chat == DEFAULT_CHAT_ID` whenever it opens an app, beside the chat's messages. The query lists its rows oldest first, by `validFrom`, so the newest `.dev` row is the landed build. Studio puts that row in the query's render window and reads its value from the window's subscription. Personas later paces its strip by the same value.
- **No landing can be missed, and Studio asks on every value.** A query answers before the first landing creates a row, as the chat's does before its first message, so a Studio open on a new app hears that first landing. `#restoreSubscriptions` sends the window's subscription again after a reconnect, so a Studio that was disconnected, asleep or not yet open gets the current value, and Studio asks its frame on every value it receives, the first and a restored one included. The requester's own preview reloads through the same subscription, so a Studio that forgot to subscribe fails every scenario that builds.
- **The landing writes `ServedBuild` as the build's caller, under the verdict of the door that admitted the build.** A turn's build is written as the poster whose message started it, with the platform as actor, the record `docs/vision/auth.md` § *When the agent acts* gives every agent write; a direct `buildNow` is written as its caller, with no actor. The door's verdict is `requireChatWrite` for `buildNow` and the post's own check for a turn. The write is a create at a fresh `crypto.randomUUID()` through `ensureResource`, the host-only method that already takes the server-composed `actor` and the pinned verdict and broadcasts a create with no originator, so the requester's Studio hears it too and the landing needs no write path of its own.
- **The Galaxy tells a turn's build from a direct one by where it runs, never by what a caller sends.** A turn's loop runs inside a Galaxy-private `AsyncLocalStorage` holding the post that started it, and `#buildAndLand` reads it: inside, the landing records the poster with the platform as actor under the post's verdict; outside, the caller with no actor under `requireChatWrite`'s. `buildNow` passes on only `preview`, so no option on the wire can claim a turn.
- **A chat participant may also write a `ServedBuild`** through the ordinary door, like any resource under the chat node. A forged row is the newest only until the next landing creates a newer one, and deleting the newest makes an older one the newest; either costs a traceable reload, which Studio asks its frame for once per value, and neither keeps the next landing from reaching every Studio.
- **Studio reloads its frame by asking it, except after a wipe.** Studio cannot read a frame's address across origins, so setting the address, as `reloadPreview` does, loses the frame's URL ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)). Instead:
  - When `ServedBuild` changes, Studio posts `{ type: 'lumenize:reload', build: '9c41e0…' }`.
  - The Reload button posts `{ type: 'lumenize:reload' }`, naming no build, which the frame obeys whatever it holds.
  - `wipe()` sets the address to the Star's root, navigating even when the frame already sits there, since the URL it was on may name data the wipe deleted.

  `onVisibilityChange`'s reload goes: a restored subscription covers a missed landing, and every landing reaches every Studio.
- **The frame decides, through the app's own hook.** In a frame, `createNebulaClient` listens for the request, and obeys only a message from `window.parent` at the `parentOrigin` it resolves, the meta's unless the app passes its own, as Studio reads only a message from the frame it created. One naming the build the frame already runs changes nothing. One naming another calls the app's `onShouldRefreshUI` with a `BuildStaleInfo`, `{ reason: 'build-stale', clientVersion: '1b7d…', currentVersion: '9c41e0…' }`, at most once from one build to another: the `sessionStorage` key `lmz.build-reloaded-for` records the build asked for and the build the page ran when it was asked. The default reloads the frame at its URL, and an app's "new version available" banner applies to a code change as it does to a type change. A request naming no build reloads the frame directly, since the person asked for it.
- **The frame answers every request, and Studio falls back only on silence.** Studio's request carries an id, as `{ type: 'lumenize:reload', id: 'r7', build: '9c41e0…' }`, and the frame echoes it at once with the build it runs, as `{ type: 'lumenize:loaded', id: 'r7', build: '1b7d…' }`. The factory also posts a `loaded` with no id synchronously when it is constructed, before any `lumenize:login-required` from the same load, so a fresh load announces itself whatever order the browser's events arrive in.
  - Studio treats an echo as proof a client is there and never forces a frame that answered, so an app showing a banner keeps its choice.
  - An unsolicited `loaded` means a client is there, so Studio sends its current request again, whatever build the message names. A request sent before the frame's listener existed, as when Studio opens, is answered that way. The frame's comparison and its `sessionStorage` guard keep a repeat harmless, and Studio resends at most once per value.
  - Studio sets the address only when it hears no client: at once when the frame's `load` event comes with no `loaded` from that load within 2 s, and otherwise when its request gets no echo, within 2 s for the Reload button and 10 s for a landing. No echo means no client: a new app's preview before its first build, an app whose `App.vue` never imports `./nebula`, or a build that broke the page.
  - Studio clears `previewNotice` on an unsolicited `loaded`, which comes before any login notice from the same load.
- **A turn that ends on a held-back build says so in its reply.** When the turn's last build was held back, for type findings, on the model's `{ "preview": false }`, or because a landing step refused it, the Galaxy appends a line of its own naming why, as `The preview was not updated: the last build was held back for its type findings.` It is our code's line, so it appears whatever the model writes, and the person reading it can answer "preview it anyway". The fallback `Updated the preview.` appears only when the last build landed.

## Constraints

- [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md): two versions compared by equality, and the build version never rides a data-op, so the Star never sees it and a code-only build refuses nobody's write.
- [ADR-017](../docs/adr/017-the-url-is-the-view-state.md): a reload lands on the same URL. That keeps the view wherever an app keeps its view in the URL, which the scaffold's `App.vue` does not yet ([backlog.md](backlog.md) § *Nebula*'s row on a URL-synced view-state store), so a `/live` scenario asserts the URL.
- `mesh.md`: Studio learns the build by subscription, as that rule prefers for live UI data, and nothing new is pushed or awaited.
- `live.md`: a `/live` scenario first. The change is to what Clients hear, so the close-out runs a deployed pass of the scenarios it writes or touches.
- `studio-guidance.md`: `preview` stays the build tool's word. Every place the model reads about it changes (§ *Current state*), the embed is regenerated, and the close-out runs that rule's three guidance scenarios, `studio-guidance-loop`, `four-party-chat` and `first-app-built`, and records a dated findings line.
- Milestone: pre-alpha, before personas. Production's one deploy is the wipe at ⑥, so no Galaxy predates `/dist-dev/`; a local or test stack answers 404 on `.dev` until its next previewed build, and nothing falls back to `dist/`.

## Future state

- **A `.draft` Star serves the latest build, previewed or not** (Larry, 2026-10-13), so the model can run its own tests and explore a build before previewing it. Every build that arrives is copied to `/dist-draft/` and gets `.draft`'s own `ServedBuild`; a preview promotes `/dist-draft/` to `/dist-dev/`, as a publish promotes `/dist-dev/` to `/dist-prod/`. It would be one more reserved Star slug ([ADR-021](../docs/adr/021-every-scope-has-its-own-host.md)); [backlog.md](backlog.md) § *Nebula* holds it.
- **Personas' strip** paces the reload request as § *Context* describes, and a frame already on the build stays put, so Studio keeps no record of what each frame loaded.
- **An environment Star that follows the build as `.dev` does** (ADR-024 leaves it open) gets the build version for free, since the Galaxy writes it on every serve, and a `ServedBuild` of its own.

## Open questions

None open.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The model's call on the preview decides what `.dev` serves** (Larry, 2026-10-13). It finishes the 2026-08-28 decision that previewing is the model's call, which the code applied only to the requester's reload. A build lands on `.dev` when it is previewed, so `/dist-dev/`, the ontology row and `.dev`'s `ServedBuild` move together, and the model gets more of this call as it comes to test and explore its own builds on a `.draft` Star. | **Pushing on every landing and removing the `preview` option:** it deletes a call the model is meant to keep and grow. **Leaving the call deciding only the reload push:** a held-back build reaches every frame that loads later, so personas' strip could hold two builds of one app at once. **A tool that previews the current `dist/` without a build:** one more tool, when building again with the override does the same at the cost of one build. |
| **A frame decides whether it is current: Studio's reload request carries the build `.dev`'s `ServedBuild` records, and the frame compares it with the `buildVersion` in its own meta** (Larry, 2026-10-13). The request exists anyway to keep the frame's URL, so the build rides it, and both the meta and the recorded build gain a reader in this task. | **Studio remembering which frames it loaded before the landing:** a frame that finished loading just after the landing reads as current while running the old build, and a frame the ontology install notice already moved reloads again. **Writing the meta only because ADR-024 says a page carries its build version, and deferring its reader to fast-follow Item 5:** the same two leaks, and personas would have to build the record Studio no longer needs. |
| **The frame handles Studio's request through `onShouldRefreshUI`, whose argument gains a `BuildStaleInfo` beside `OntologyStaleInfo`, and answers with a `lumenize:loaded` post** (Larry, 2026-10-13). One hook then covers every way a page learns it is stale, so an app's "new version available" banner applies to a code change too, and fast-follow Item 5's own check lands on the same hook. Answering at once, before any reload, lets Studio tell a frame that chose to wait from one with no client. | **A listener of the client's own that reloads directly:** a second way to reload that bypasses an app's override, and Item 5 would add a third. **One `StaleInfo` in place of `OntologyStaleInfo`:** a documented public type renamed, where a sibling leaves each name saying what it holds. **The frame reporting its location, which Studio keeps in its own URL:** it also fixes a Studio reload landing the preview on the root, but the client would have to watch the app's router for every navigation, and it does not replace the request. It joins `backlog.md` § *Nebula Studio UI*'s row on reflecting `activeScope` in the URL. |
| **Studio learns the landed build from `.dev`'s `ServedBuild`, a resource it subscribes to, rather than from a push** (Larry, 2026-10-13, from the second Stage 1 pass). `mesh.md` prefers a subscription for live UI data, and this one is built already: a restored subscription delivers the current value, so a landing Studio missed while disconnected cannot stay missed. It replaces Item 8's list of who has the app open (Larry, 2026-08-28) and answers both its warnings. A closed tab drops off when a write fails to reach it, so how long that takes no longer matters. And nobody can forget to enrol unnoticed, because the requester's own reload rides the same subscription. `ServedBuild` names what a Star's host serves, one per Star that follows the build: `.dev`'s now, and `.draft`'s when it exists. | **A push to the chat query's subscribers, through a new `Resources.sendToSubscribers`:** a push sent while Studio's socket is down past the Gateway's grace is lost for good, and the return after 4 minutes could not recover it, since it names the last build Studio heard. **That push plus asking the Galaxy on every reconnect:** two mechanisms for one fact. **A `buildVersion` field on the `Chat`:** no `Chat` resource is stored for it to sit on, and creating one would need a title nobody chose. **`LandedBuild`:** once a `.draft` Star exists every build lands there and only a preview lands it on `.dev`, so the name stops saying which. |
| **Studio subscribes through a query, `ServedBuild where chat == DEFAULT_CHAT_ID`, rather than to the resource by its id** (2026-10-13, from Stage 2). A query answers with no rows, so a Studio open on a new app hears its first landing, the way the chat's query hears a first message. | **A subscription by id:** `subscribeResource` refuses an id with no snapshot, so a Studio open on a new app would never hear its first landing. **Seeding `ServedBuild` when a Galaxy is created:** one more step in creating an app, and a Galaxy created before it would still lack the row. **A plane that registers a subscription to an absent id:** the read check needs the resource's node, which an absent id does not have. **One row at a constant id:** any chat participant could delete it, or create something else there first, and every Studio would stop hearing landings. |
| **The landing writes `ServedBuild` as the build's caller, under the verdict pinned at the door that admitted the build, through `ensureResource` at a fresh id per landing** (Larry, 2026-10-13, from Stage 2; the fresh id from the second Stage 2 pass). It is the record `docs/vision/auth.md` § *When the agent acts* gives every agent write, *this human, via the agent*, and the pinned verdict means a grant that lapses while the build waits cannot refuse the write after `.dev` has moved. | **Writing it as `agent:lumenize`, the subject the agent posts under:** `auth.md` confines that subject to a chat Message on purpose. **Writing through `doTransaction`, which checks the live grant at commit:** a grant revoked while the build waited in the queue refuses the write after `.dev` has moved, so `.dev` serves one build while `ServedBuild` names another. **A host-only upsert at a constant id:** a put over a deleted row stays deleted, over another type fails validation, and the read before it checks the live grant, so it needed a write path of its own to be safe, where a create at a fresh id needs none. |
| **A chat participant may write a `ServedBuild` like any resource under the chat node** (2026-10-13, from Stage 2). With a fresh id per landing, a forged or deleted row costs one traceable reload per value, and the next landing's row is the newest again. | **The door refusing every op on `ServedBuild`:** a rule of its own for a value whose forgery costs reversible reloads (calibration §15). |
| **A turn's landing is told from a direct `buildNow` by a Galaxy-private `AsyncLocalStorage` entered around the turn's loop** (2026-10-13, from Stage 2). Where the build runs decides it, so no caller can claim to be a turn. | **A flag on `buildNow`'s options:** the wire reaches them, so any chat-floor caller could have its landing recorded as the agent's. **Reading `#turnInFlight`:** a direct `buildNow` P sends during O's turn would be recorded as O's turn. **Routing the loop's `build` to a method of its own:** it would leave `LOOP_TOOL_ENTRIES`, whose test holds every entry to the chat floor. |
| **`pinnedAtPost` is renamed `pinnedAtDoor`** (2026-10-13, from Stage 2). A landing's verdict comes from `buildNow`'s door as well as from a post, and the old name already needed explaining (calibration §5). | **Keeping the name:** every reader of a landing's write would have to learn that the "post" can be a `buildNow` call. |
| **A turn that ends on a held-back build says so in its reply, in a line our code appends** (Larry, 2026-10-13). The 2026-08-28 decision rejected a separate `publish` tool because forgetting it left "a silently stale preview", and a held-back build at the end of a turn is that failure again. What it objected to was the silence, so the line removes the silence and leaves the call with the model. | **The loop warning the model when it calls `mark_complete` on a held-back build:** it relies on the model acting on the warning, and can be added if the agent messages' `codegen.toolCalls` show turns often end that way. **`mark_complete` taking `{ "preview": true }` and landing the last build without building again:** a second path to a landing that is not a build. |
| **A page outside Studio, and a reload carrying unsaved writes, wait for fast-follow Items 5 and 4** (Larry, 2026-10-13). The Studios subscribed to `.dev`'s `ServedBuild` are reached, but a page in a tab of its own is not, and the check that does reach it is the one a published page runs, which wants a cache in front of the Galaxy first. A carry is wanted on every Star, where it must also migrate a write forward, beside a durable outbox in Mesh that holds a call in flight across the same reload. Built for `.dev` now, each would be built again or reconciled then. | **A page in a tab of its own checking its build, built for `.dev` now:** it would be built without the cache a published Star needs. **Carrying unsaved writes across a reload in `sessionStorage`, built for `.dev` now:** it would leave two paths sending one write again once the outbox lands. **A frame Studio asks to reload sending its unsaved writes first,** through the `dispose()` every client has (Larry, 2026-10-13): the call is one line, but it wants a `/live` limb of its own and goes once the carry lands, to save at most two seconds of typing on test data now and then. |
| **The build's type check reads the code the app is built with: its own `tsconfig.json` and `src/`, the installed `vue`, and the vendored `@lumenize/resources`** (Larry, 2026-10-15, at the hand-off). Holding back a build with findings makes a false finding cost a correct app its preview, and the hand-written copy the check read lacked seven things the docs teach before this build widened it. The real client is wider than the docs, so a call they do not teach, such as `client.lmz`, type-checks; the docs and the platform guidance steer what the model calls, and the Gateway checks every call a page sends. | **Keeping the copy until a later task derives it:** each client change in between risks another correct app held back. **A documented subset of the real client:** its signatures are derived, but its member list is kept by hand and drifts the same way. **Generating the copy's text from the real types:** still a copy, and bundling declarations would take a new dependency. **Making findings advisory until then:** a type-wrong build would reach every Studio's preview, since every Studio now reloads on each landing. |
| **Both reload guards record the version a refresh was for and the version the tab ran when it asked, and stay put only while both hold** (Larry, 2026-10-15, at the hand-off). A refresh that did not take, a stale cache bringing back the old page, still stops its loop, and a page that moved past the version it once refreshed for is asked again: a frame Studio asked onto build B that landed on a newer C, when a later revert brings B back, and a tab whose ontology guard names a version the Star reverted to, whose every write would otherwise end `ontology-stale` with no reload. | **Recording the version asked for alone**, as both guards did: either case above stays put with no signal, until the next landing or a reload by hand. |

## Phases

Each phase leaves `npm run type-check` and `npm test` green, and its changed source files clean of task-file handles under `grep -nE '\b[SD](1[0-9]|[1-9])\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b'`. Phases 1 and 4 change what every container scenario sees, so they run `drive.ts all` with its Docker scenarios; Phases 2 and 3 run `drive.ts all --fast` and the container scenarios they touch. The witnesses are two `/live` scenarios, both declaring `needsContainer`, each claiming its own app and building an app of its own as `dev-tab-frame` does: `dev-star-follows-the-build`, which gains limbs, and a new `build-reaches-every-studio`. An in-lane test says on itself why it needs no running system.

1. **A build lands on `.dev` only when it is previewed, into a copy outside `/workspace`.**
   - **One predicate.** `decideLanding` absorbs `decidePreview`, as § *Design intent* says, and `#buildAndLand` decides once, before it lands anything. The report's `preview` step is the landing's outcome, and `refreshed`'s JSDoc comes to say `.dev` now serves the build. A second pure predicate over the turn's last report says whether the turn ended held back, and both the reply's line and the `Updated the preview.` fallback read it (calibration §12).
   - **The landing.** The steps run in § *Design intent*'s order, all but step 5, which Phase 3 adds, and copy only the files absent from `/dist-dev/` or whose bytes differ. Until Phase 4 removes it, the requester's push still fires, now on a landing.
   - **The serve path.** `#serveBuiltApp` serves `.dev` from `/dist-dev/`, read without the `/workspace` prefix, and writes `buildVersion` into the meta from the `/dist-dev/index.html` it serves.
   - **What stops landing.** A scenario whose fixture carries type findings to test something else keeps its fixture clean, and one that tests the findings passes `{ "preview": true }`. `first-app-built` and the ui-smoke codegen test read the turn's last build's `preview` step, which `first-app-built`'s `latestAgentManifest` already extracts: when it was held back, they assert the reply's line, then call `buildNow({ preview: true })` before checking what `.dev` serves. `build-box` asserts the seed's first build has no findings, so a seed that grows one reds by name rather than as a 404 in every scenario that builds it.
   - **`security.md`.** Its bullet on the chat floor comes to say a landing moves `.dev`'s served copy and its row.
   - **Success criteria (capable of failing):**
     - `dev-star-follows-the-build` gains a limb, *a held-back build changes nothing anyone sees*. A build that changes a visible string in `App.vue` and carries a type finding lands nothing by default: a page loaded afterwards shows the old string, its meta's `buildVersion` is the earlier landing's `bundle.indexSha256`, and the report reads `refreshed: false`. Building again with `{ "preview": true }` serves the new string under the new digest.
     - Vitest, unit lane, a table over `decideLanding`, which is a pure function, as `ontology-landing.test.ts`'s header argues: a clean build lands; one with findings is held back, and lands on `{ "preview": true }`; a clean one is held back on `{ "preview": false }`; a failed bundle, a `dist` that did not arrive, or a successful bundle with no `indexSha256` lands nothing under any override. The `decidePreview` rows in `codegen-loop.test.ts` fold into it.
     - Vitest, unit lane, a table over the held-back predicate: a build held back for findings, a clean one on `{ "preview": false }`, a failed bundle and a refused row each count as held back; a landed build does not.
     - Vitest, dev-studio lane: the existing stale-row and mislabeled-row cases also leave `/dist-dev/index.html` as it was and report `refreshed: false` with the row check's `why`. They run in the lane because a scripted fault makes the planted row certain; in production the build's own `vite.config.ts` could write one.
     - Vitest, baseline lane, through `callGalaxyChatScripted` as `update-identity.test.ts` drives a turn, with `BuildFaults` in `fake-build.ts` gaining `findings`: a turn whose last build was held back for a finding commits a reply ending with the line, and one whose last build landed does not; with no reply from the model and files changed, `Updated the preview.` appears only for the landed turn.
     - Vitest, baseline lane: a second build that changes only the bytes of `public/assets/logo-a1b2c3d4.png`, a name that looks hashed, serves the new bytes from `/dist-dev/`. It runs in the lane because the build seam writes exact files; a real build would need a fixture image.
     - Vitest, baseline lane, `entrypoint-routing-contract.test.ts`: its second anchor seeds `.dev` through a landing and reads `buildVersion` from the meta, and it gains the inversion, that a chat-floor `writeSource('dist/index.html')` changes nothing `.dev` serves.
   - **Mutation note:** the new limb reds when `.dev` serves `/workspace/dist/` again, and its digest check reds when `buildVersion` is read from `/workspace/dist/index.html`. Each table row reds when its own arm is flipped, and the held-back table's `{ "preview": false }` row reds when the predicate reads only the findings. The row cases red when the copy runs before the row's check. The reply test reds when the line is appended on every turn or on none, and its fallback half when the fallback ignores the predicate. The inversion reds when `.dev` serves `/workspace/dist/`, and the asset test reds when the copy skips a file by its name alone.

2. **A framed page decides whether a reload request moves it, and answers.**
   - **Reading the build.** In a frame, `createNebulaClient` reads `buildVersion` from the meta itself, beside `parentOriginOfPage`. `nebula.ts`'s header, which says the seed's app imports it, is corrected: neither the seed's `App.vue` nor its `main.ts` does.
   - **The decision.** A pure function decides from the request's build, the meta's, and the guard key: stay and answer, or call `onShouldRefreshUI` with a `BuildStaleInfo` and set `lmz.build-reloaded-for`, or, for a request naming no build, reload directly. `BuildStaleInfo` is exported beside `OntologyStaleInfo`, and the hook's parameter takes either.
   - **The answer.** The factory installs its listener and posts an unsolicited `loaded` synchronously when it is constructed, before any `login-required` from the same load, and echoes each request's id with the build it runs. It obeys only a message from `window.parent` at the `parentOrigin` it resolves.
   - **Success criteria (capable of failing):**
     - Vitest, frontend lane, a table over the decision, which is a pure function by design (calibration §12): a request naming the meta's build stays; one naming another, with the guard unset, calls the hook once with `{ reason: 'build-stale', clientVersion, currentVersion }`; the same request with the guard set does not; a request naming no build reloads.
     - Vitest, frontend lane: a `lumenize:reload` from `window.parent` at another origin is ignored and answered with nothing. It runs in the lane because `frame-ancestors` lets only Studio's origin frame the dev tab, so no running system can post from the parent at another origin; the wrong-window case is a live limb in Phase 4.
     - Vitest, frontend lane: a factory constructed in a frame with no session posts `loaded` before `login-required`.
   - **Mutation note:** each table row reds when its arm is flipped, the origin test reds when the origin check is dropped, and the order test reds when `loaded` is posted after `ready` settles.

3. **Each landing records its build in a `.dev` `ServedBuild`.**
   - **The type.** `chat-constants.ts` gains `interface ServedBuild { chat: Chat; star: string; buildVersion: string }`, and the seed regenerates as `chat-message-v2` with its bundle id bumped, as `gen-validator-seeds.ts`'s header requires. `CHAT_MESSAGE_TYPES`' JSDoc and that header both say a bump fails every client with no way to re-seed. `Resources.#settle` now installs the source row on a mismatch, so both are re-derived here (calibration §4).
   - **The write.** Landing step 5 calls `ensureResource` at a fresh id with the verdict and the actor § *Design intent* gives. The Galaxy enters its private `AsyncLocalStorage` around a turn's loop, `#buildAndLand` reads it, and `buildNow`'s JSDoc says every in-process caller has already passed the chat floor. The in-lane build helpers, `dev-studio.test.ts`'s `build` and `codegen-loop.test.ts`'s `runLoopForTest`, move onto calls that carry claims, so they run the production path.
   - **The flag and its fence.** `pinnedAtPost` becomes `pinnedAtDoor`, and `TransactionOpts`' JSDoc says the verdict comes from whichever door admitted the work, a post or `buildNow`'s. The comment on the Galaxy's `resources` getter that names `commitAgentMessage` as the only supplier of an actor comes to say only host code calling `ensureResource` supplies one.
   - **`security.md`.** The floor bullet gains `ServedBuild`. The bullet on a turn's authority comes to state the rule by its structure: a write runs under the verdict of whichever door admitted it, the Message create for a turn and `requireChatWrite` for a direct `buildNow`, both DAG `write` at `CHAT_NODE_ID`, and only server code composes it.
   - **The sibling.** In the same commit, `nebula-agent-posts-as-itself.md` § *What changes* keeps `pinnedAtDoor` and `actor`, with the landing as their caller, and its open question on `actor`'s callers is re-derived.
   - **Success criteria (capable of failing):**
     - Phase 1's limb also subscribes the scenario's `studio` driver, the client that calls `buildNow`, to the `ServedBuild` query, and reads the newest `.dev` row through its render window: after the first landing it names that build's `indexSha256`, after the held-back build the same value, and after the previewed rebuild the new one.
     - Vitest, baseline lane, the version bump: through `setChatSourceForTest`, on a Galaxy installed at `chat-message-v1`, a client pinned at `chat-message-v2` subscribes to the `ServedBuild` query and a landing creates a row.
     - Vitest, baseline lane, the verdict: a landing whose caller's grant at the chat node is revoked outright while the build waits in the queue still creates its row. It runs in the lane because only there can the build be held while the grant is revoked.
     - Vitest, baseline lane, the record: a turn's landing carries the poster as subject and the platform as actor. A direct `buildNow` carries no actor, including one sent with an extra option and one P sends during O's turn.
     - Vitest, baseline lane, forgery: after a participant creates a newer `ServedBuild` and then deletes the newest, the next landing's row is the newest and reaches a subscriber.
     - `grep -rn pinnedAtPost packages apps .claude/rules --include='*.ts' --include='*.md' --exclude-dir=node_modules` prints nothing; run on 2026-10-13, it prints ten lines in six files, `security.md` among them.
     - `grep -n 'only the server-internal' apps/nebula/src/galaxy.ts` prints nothing; on 2026-10-13 it prints the `resources` getter's comment.
     - `npx tsx apps/nebula/scripts/gen-validator-seeds.ts --check` passes.
   - **Mutation note:** the limb reds when step 5 is skipped, when it runs for a held-back build, and when the caller's address is passed as the broadcast's originator. The bump test reds without the bump. The verdict test reds when step 5 checks the live grant. The record test reds when a turn's landing stamps no actor, when an option on `buildNow` can set one, and when `#turnInFlight` decides it. The forgery test reds when the landing writes at a constant id.

4. **Every Studio on the app asks its frame to reload on each landing, and the push goes.**
   - **The subscription.** Studio subscribes to the `ServedBuild` query whenever it opens an app, beside the chat's messages, puts the newest `.dev` row in its render window, and asks its frame as § *Design intent* says. Studio's choice among asking, asking again and setting the address is a pure function in `apps/nebula/src`, exported through `@lumenize/nebula/client` beside `deriveTurnDisplay`, so the order of a template's branches decides nothing (calibration §12). `wipe()` navigates the frame to the Star's root even when it already sits there, by keying the iframe afresh.
   - **What goes.** The requester's push end to end, as § *Current state* lists it, and `onVisibilityChange`'s reload. Every test and scenario that asserts the push changes:
     - `build-reply.test.ts` and `nebula-client-preview-ready.test.ts` go, and so does `StudioClientTest.handlePreviewReady` in the baseline test app.
     - `update-identity.test.ts` waits on `previewReadyCount`; its identity-stamping check moves onto a `ServedBuild` subscriber.
     - `galaxy-resource-surface.test.ts` stops listing `deliverPreviewReady`.
     - `first-app-built`'s limbs 5 and 6, which watch for `?t=` and read a bare `src` as no push, observe a navigation of the frame instead.
     - The comments in `star-serves-current-ontology.ts` and `dev-star-follows-the-build.ts` that describe the push say what replaced it.

     `#buildAndAnnounce` is renamed for queueing builds, and each JSDoc and comment § *Current state* names comes to say every Studio subscribed to the `ServedBuild` query hears every landing.
   - **ui-smoke.** Its codegen test waits for a navigation of the Preview frame, which the request and the fallback both cause, since the `?t=` it watched for no longer appears and the seed's app posts no `loaded`.
   - **Success criteria (capable of failing):** a new scenario, `build-reaches-every-studio`. O owns the app and P is a collaborator at the chat floor, each with Studio open in a browser context of their own. The app is the scenario's, with a route `/deals/42`, a mark left on `window` at each load, and a record of every `lumenize:reload` the frame receives.
     - Limb 1, *a landing reloads every preview at its URL*: both frames sit at `/deals/42`, O's `buildNow` lands, and both frames lose their mark and stay at `/deals/42`.
     - Limb 2, *a landing Studio missed arrives when it comes back*, in this order: P's Studio is paused through CDP's `Debugger.pause`; O creates a `ServedBuild` naming the current build through the ordinary door, a write that starts no turn, and its push goes unanswered by P past its host node's 30 s wait, so the host closes P with 4408 and drops its subscriptions; the limb waits for the reap marker, or 35 s past the grace period where the stack's logs cannot be read; O lands build B; P resumes and subscribes again; and P's frame ends on B. Only the restored subscription can deliver B, since the landing's write reached no subscription of P's. No agent `Message` is committed while the limb runs.
     - Limb 3, *a frame already current stays put*: P opens Studio fresh after a landing, the frame records a request naming the build it runs, and its mark survives 15 s.
     - Limb 4, *an app's banner keeps its choice*: the app's `onShouldRefreshUI` shows a banner instead of reloading; after a landing the banner shows, and the frame keeps its mark and URL past Studio's 10 s wait.
     - Limb 5, *the Reload button*: on a current frame the frame navigates and keeps its URL, and on a preview with no client, before the app's first build, Studio navigates it within 2 s. Both are seen as navigations of the frame, never read from its `src`.
     - Limb 6, *a request from another window is ignored*: an `about:blank` frame at Studio's origin posts `lumenize:reload` to the dev tab, which neither reloads nor answers, while a request from Studio itself, the positive control, is obeyed.
     - Before `dev-star-follows-the-build`'s Wipe, the frame moves to a sub-path and takes a mark; after it, the frame sits at the Star's root with the mark gone.
     - `dev-tab-frame`'s limb that shows Studio's notice finds it still up a few seconds after the frame settles, and gone after the frame's next load.
     - Vitest, unit lane, a table over Studio's decision: ask on a first value and on a changed one; on an unsolicited `loaded`, whatever build it names, send the current request once more, then stop; a request sent before the load's `loaded` is resent when it comes; set the address after a `load` with no `loaded`, and after a request with no echo; never force a frame that echoed.
   - **Mutation note:** limb 1 reds when Studio skips the subscription, which no push now covers, and when it sets the address instead of asking. Limb 2 reds when Studio ignores the first value a restored subscription delivers, and its no-turn check reds if the limb's write starts a turn. Limb 3 reds when the frame skips its comparison, and when Studio posts nothing on a first value. Limb 4 reds when Studio falls back on an echo naming the old build. Limb 5 reds when the button names the current build, and when the no-client fallback waits 10 s. Limb 6 reds when the frame drops its `window.parent` check. The Wipe check reds when `wipe()` asks the frame. The notice check reds when `loaded` clears a notice raised after it, and when it clears none.

5. **What the model and the docs say about a preview matches what it does.**
   - **The model's prose.** Every place § *Current state* lists under what the model reads about `preview` comes to say a build the model does not preview is served nowhere, and the two docs say what § *Current state* gives them. `api-reference.md`'s `parentOrigin` row names all three of its uses: where a login notice goes, where `loaded` goes, and whose requests the frame obeys. `gen-platform.mjs` regenerates the embed.
   - **ADR-024.** The five amendments § *Relationships* lists.
   - **Before the deploy.** Every branch on `HARNESS_TARGET_URL` or the stack's logs in the scenarios this task writes or touches is read against the new path, as `live.md` requires, found by `grep -rlnE 'HARNESS_TARGET_URL|stack\.logs' apps/nebula/harness`. Limb 2's fixed wait is that branch for its reap marker.
   - **Success criteria (capable of failing):**
     - `node apps/nebula/scripts/gen-platform.mjs --check` passes, and `test/platform-embed-drift.test.ts` is green.
     - `grep -rnE 'withheld by default|override on build is yours|refresh it alongside findings|refreshes the \.dev preview even' apps/nebula/src apps/nebula/platform website/docs/nebula` prints nothing. Run on 2026-10-13, it prints five lines, in `galaxy.ts`, `codegen-loop.ts` and `tool-args-constants.ts`.
     - `grep -c 'served nowhere' apps/nebula/src/codegen-loop.ts apps/nebula/src/build-report.ts` finds the sentence in both, where the model reads what a held-back build does. Run on 2026-10-13, it finds it in neither.
     - `studio-guidance-loop`, `four-party-chat` and `first-app-built` pass, and a dated findings line lands in `nebula-pre-alpha.md` § *Data-bound generation*, as `studio-guidance.md` requires.
     - `drive.ts all` passes, the Docker scenarios included, since this task changes what scenarios it did not write depend on (`live.md`).
     - After `deploy-test.sh`, `build-reaches-every-studio`, `dev-star-follows-the-build` and `dev-tab-frame` pass against the deployed worker beside a `wrangler tail` capture.
   - **Mutation note:** the first grep reds while a stale line survives, the second while the new sentence is missing, and the drift test reds on a stale embed.

## Non-goals

- **A page outside Studio checking its own build:** fast-follow Item 5.
- **Carrying unsaved writes across a reload:** fast-follow Item 4, beside Mesh 1.0 Item 11's durable outbox.
- **A `.draft` Star:** [backlog.md](backlog.md) § *Nebula*.
- **Studio's URL carrying the preview's path:** the row on reflecting `activeScope` in the URL, in `backlog.md` § *Nebula Studio UI*.
- **A richer login notice,** with a kind, a status, a reason and a recheck of Studio's session: the login-notice row in the same section.
- **The loop warning the model at `mark_complete` on a held-back build:** § *Decisions*, to be added if turns often end that way.

## Build notes

**Open for Larry.** No decision; notes that need none:

Notes: Studio's one extra reload of a page with no client (Phase 4); the `.draft` Star and the newest `.dev` row, and the record from served bytes (§ *The verifier panel*); the certificate stalls and the bodied-GET fix (§ *The deployed pass*).

### Phase 1 — a build lands on `.dev` only when it is previewed (2026-10-14)

**For Larry:**

- **A turn that changes files and never builds now ends `Saved the changes; nothing was built, so the preview is unchanged.`** The task said only that `Updated the preview.` appears when the last build landed, which left the no-build case without a sentence; the old fallback claimed a preview that had not moved.
- **The SFC contract was missing most of the client surface `api-reference.md` teaches, and this phase made that gap hold builds back.** `NEBULA_API_DTS` in `apps/nebula/src/sfc-contract.ts` listed five `client.resources` methods and no `subscribeQuery`, so a list view drew a false finding. Findings were advisory until now; with a held-back default, a correct app that lists anything stays off `.dev` until the model previews it. `dev-star-follows-the-build` limb 8 found it: its list app was held back and its page waited on an app `.dev` never served. The contract now carries every documented `client.*` call, loosely typed where the doc's types are rich, and `codegen-gate.test.ts` pins the list case. Deriving the contract from the client's own types would remove the class rather than patch it, and is proposed as a backlog row at close-out.
- **The asset test changes the bytes of `assets/logo-a1b2c3d4.png`,** where vite puts `public/assets/logo-a1b2c3d4.png`, through `BuildFaults.distFiles`, as the criterion asks. *(Corrected after the verifier panel: this note first named a different file.)*

**Verified:** `drive.ts all` with Docker, 65 of 65 in 35.9 min; the ui-smoke lane, 8 of 8; `apps/nebula`'s `npm test`, 1061 passed, its three failures being Phase 2's frontend tests written ahead of their code and left out of this commit. Limb 10 reds alone when `.dev` serves `/workspace/dist/` and when `buildVersion` is read from `/workspace/dist/index.html`, each a run of its own.

**Retro:**

- Two test files the phase did not otherwise touch encoded the old strings, `history-bundle.test.ts` the old fallback and `codegen-loop.test.ts` the override's `why`. Only the full suite found them.
- The phase's own rule about scenarios whose fixtures carry findings anticipated a fixture at fault. The first finding that held a scenario back was the contract's, on correct code.

**Close-out:**

- `decidePreview` is gone; its rows live in `ontology-landing.test.ts`'s `decideLanding` table.
- `connectDriver` takes `Pick<DevStack, 'baseUrl' | 'origin'>`, so the ui-smoke lane can preview a held-back build through it.

### Phase 2 — a framed page decides whether a reload request moves it, and answers (2026-10-15)

**For Larry:**

- **Widening `onShouldRefreshUI`'s parameter breaks an app that typed its hook narrowly.** Under strict function types, `(info: OntologyStaleInfo) => void` no longer fits a hook that may be handed a `BuildStaleInfo`; three baseline tests did exactly that and now name the union. The scaffold's `nebula.ts` passes no hook, and a hook reading only `currentVersion` still fits. Both stale infos are now exported from `@lumenize/resources/client`, so an app can name them.

**Retro:**

- The decision, the answer and the first `loaded` landed in one pass, and all seven mutations reddened their own rows. The order test needed no browser: jsdom stands a frame up once `window.top` is mocked, and a `fetch` answering 401 drives the factory to `login-required`.

**Close-out:**

- Verified with `packages/resources`' suite (17), `apps/nebula`'s (1064 passed) and `dev-tab-frame` with Docker. The frame's code runs only in a page framed with a named parent, which no container-free scenario builds, so the `--fast` sweep runs once at Phase 3's gate and covers both phases.

### Phase 3 — each landing records its build in a `.dev` `ServedBuild` (2026-10-15)

**For Larry:**

- **The landing's broadcast has no originator to matter.** The *write as caller* Decision says the landing reuses `ensureResource` because it "broadcasts a create with no originator, so the requester's Studio hears it too". The broadcast does carry no originator, but for a create at a fresh id it reaches nobody: no tab subscribes to an id before it exists, and Studio learns the row from the query's rerun, which takes no originator at all. Removing the broadcast outright left every `ServedBuild` test green, so the Phase 3 mutation note's *caller's address as originator* cannot red, and none was written for it. The requester still hears its own landing, by the query. Nothing to change; the Decision's reason is the query, not the originator.
- **The `dev-studio` lane's direct calls now carry an admin's call context.** Its builds ran in-DO with none, so sixteen landings logged `served build not recorded` and differed from production's. `test/test-apps/dev-studio/as-caller.ts` runs each `inDO` callback under a covering admin's claims through Mesh's internal context store, imported by path. It restores the claims the code below the door reads; the door itself, passage and the guard, stays skipped, as `runInDurableObject` always has. The criterion asked for "calls that carry claims, so they run the production path"; a mesh envelope only acks, so the report a test reads could not come back through one.
- **`ensureResource`'s JSDoc named a `Session` seed that no longer exists**, and a task handle. Both are gone; it now names its two callers and says what `pinnedAtDoor` skips.

**Retro:**

- All four `served-build.test.ts` cases passed on first write, and all six mutations reddened their own case. The first version of the bump mutation, the label alone, reddened every case: with the seed row still at `chat-message-v2`, every client pinned to `chat-message-v1` was stale. Changing the label and the seed row's version together isolated the bump case.
- `security.md`'s turn-authority bullet is now stated by its structure, the door that admitted the work, so the landing joins the turn without a second rule.

**Close-out:**

- `nebula-agent-posts-as-itself.md` amended in this commit: it keeps `pinnedAtDoor` and `actor`, with the landing as their caller, and its open question 4 is settled.
- Verified: `packages/resources` (17), `apps/nebula` (1068 passed, no `served build not recorded` anywhere in the run), `dev-star-follows-the-build` with Docker, and `drive.ts all --fast`, 55 of 55 in 24.5 min, which also covers Phase 2's frame code.

### Phase 4 — every Studio on the app asks its frame to reload on each landing, and the push goes (2026-10-15)

**For Larry:**

- **Studio sets the frame's address once when it opens on an app whose page has no client.** The seed's app and any `App.vue` that never imports `./nebula` post no `lumenize:loaded`, so the first `ServedBuild` value finds nobody to ask, and Studio navigates the frame to the Star's root after 2 s or 10 s. It is one harmless reload, and the design says Studio falls back only on silence; `first-app-built`'s limb 6 therefore asserts that a reloaded Studio leaves the frame put only when the frame posted `loaded`, and says which case it saw.
- **`dev-star-follows-the-build`'s limb 2 app now imports `./nebula`.** The Wipe check in limb 4 needs a client in the frame: with none, a Wipe that asked the frame would fall back to setting the address, and the check could not red.
- **`StudioClient`'s home was re-derived.** Its JSDoc said it lives in `apps/nebula` because the Galaxy names the class it pushes to; with the push gone, the reason that holds is that posting writes a `Message` at `DEFAULT_CHAT_ID`, which `@lumenize/resources` may not import.

**Retro:**

- All seven limbs passed on first write, and three of nine limb mutations then survived, each for a timing reason in the scenario rather than in the code. The 5b mark landed on the iframe's first `about:blank`, which the real load replaced at about 2 s whatever Studio did. Limb 3's frame reloaded on the request before its mark went on. Limb 2's reap marker belonged to limb 3's closed tab, so P was never dropped before the landing and heard it live. Each fix built the shape the limb was about: mark only the dev host's document, count loads per tab, and reap the closed tab before pausing P. All nine now red their own limb, `limb1-no-sub` at the first build's setup, where no frame reloads at all.
- The deleted push had a test that asserted the requester alone was told, `build-reply.test.ts` T3. It encoded the old design, so it went with the push rather than inverting; every Studio hearing every landing is `build-reaches-every-studio` limb 1 and `served-build.test.ts`.

**Close-out:**

- Gone: `announceBuildToRequester`, `deliverPreviewReady`, `onPreviewReadyUndelivered`, `StudioClient.handlePreviewReady` and `onPreviewReady`, the test subclass's capture, `build-reply.test.ts`, `nebula-client-preview-ready.test.ts`, Studio's `reloadPreview`, its `?t=` and `onVisibilityChange`. `#buildAndAnnounce` is `#queueBuild`.
- `backlog.md`'s login-notice row: the clearing is built.
- Verified: `preview-frame.test.ts`'s table under seven mutations; `apps/nebula` 1073 passed (1068 + 11 − 6 deleted); `drive.ts all` with Docker, 66 of 66 in 37.7 min; the ui-smoke lane, 8 of 8.

### Phase 5 — what the model and the docs say about a preview matches what it does (2026-10-15)

**For Larry:**

- **The guidance scenarios moved, and two causes moved at once.** `first-app-built`'s real turn ended `loop-detected` in the Phase 1 sweep, after 23 rounds and 5 builds, the last held back for type findings; the reply carried the held-back line, and the scenario's preview-anyway landed it. It completed with a clean landing in this phase's sweep, after the build tool's prose changed and the SFC contract widened. The findings lines in `nebula-pre-alpha.md` § *Data-bound generation* record both runs and credit neither. The manifest now prints the last build's findings, which the Phase 1 run did not record.

**Retro:**

- The deployed pass ran on `22874a6`: `build-reaches-every-studio`, `dev-tab-frame`, `build-box` and `first-app-built` passed, the last with its turn landing clean in 11 rounds. `dev-star-follows-the-build` failed at sign-up, before any of this task's code: the new app's certificate pack sat in `pending_validation` for the whole six-minute wait. The panel's fixes changed source after that pass, so the deployed pass runs again on the fixed tree.

**Close-out:**

- Verified: `gen-platform --check` and `gen-validator-seeds --check` in sync; the two greps print nothing on the final tree and reproduce their *Today* counts at `cd27912` (3 and 5 hits); `drive.ts all` with Docker 66 of 66, `studio-guidance-loop` 6 of 6.

### The verifier panel (2026-10-15)

Five read-only verifiers, one per phase. Phases 2, 3 and 5 conformed; Phases 1 and 4 each had one major. Every finding was fixed, except where noted for Larry below.

**Majors, fixed:**

- **Phase 1: the SFC contract still drew false findings on what the docs teach,** which a held-back default turns into correct apps kept off `.dev`. The contract now carries a `*.vue` module, so a component import resolves; `@lumenize/resources/frontend`; `claims.access`; the documented five-kind `TransactionOutcome`; `deniedNodes` and `onChange` on a subscription; the common Vue lifecycle and reactivity calls; and `Symbol.dispose`, which the checker's lib lacked. `codegen-gate.test.ts` checks an app written as the docs teach, and each of seven widenings reds it alone. The class is a backlog row: derive the contract from the client's own types.
- **Phase 4: limb 2 counted reap lines rather than naming P's.** Deployed, limb 3's closed tab could be reaped late enough to pass as P's, and P would then hear the landing live. The limb now matches the reap to P's own tab id, which P's page keeps under `lmz_tab`, and waits with `LOG_WAIT_MS`.

**Minors, fixed:** the held-back line names findings only when findings held the build back (one shared `why`); the reply's fallback is a pure `completedTurnFallback`, so a preview-it-anyway turn with no file written says `Updated the preview.`; a report listing a file outside `dist/` is refused; the `ServedBuild` is named from the bytes `.dev` now serves, so it and the page's meta cannot disagree; a fresh `loaded` and a wipe clear Studio's pending request, so its window never forces a frame that has a client; limb 10 checks no row names the held-back build once the previewed landing's row is newest; the build tool says "every Studio on the app", and `TOOL_CONTRACT` and `mark_complete` say a build not previewed is served nowhere and leave how to preview one to the tool; stale comments and JSDocs in `nebula.ts`, `createNebulaClient`, `ensureResource`, `App.vue`, `codegen-loop.test.ts` and two scenarios; every active task file that named a removed symbol.

**Found while running the panel's missing mutations:**

- **The Wipe check in `dev-star-follows-the-build` could not fail.** Under a Wipe that asked the frame instead of setting its address, the frame still ended at the root: it was still limb 1's page, which has no client, so Studio's fallback set the address anyway. The check now waits until the frame answers a request naming its own build, its positive control, before it marks the frame and wipes.
- **Limb 10's new barrier check could never pass**, since the previewed rebuild of the held-back source has the held-back build's digest. It now counts the rows recorded since the clean build.
- `dev-tab-frame`'s two notice checks each red alone: under a clear that never fires (limb 4) and under a first `loaded` posted after `login-required` (limb 5). Limb 2's restore mutation reds limb 2 with the reap keyed to P's tab id.

**For Larry, from the panel:**

- **The frame's build guard keys on the build it was asked for, not the pair.** A reload that lands on a newer build than the one requested leaves the guard naming a build the page never ran, so a later request for exactly that build stays put until the next landing or the Reload button. This matches the ontology guard and the "once per build" design; keying on the pair would close it.
- **Studio reads the newest `ServedBuild` overall and accepts it only when it is `.dev`'s.** Today only `.dev` writes rows. Once the `.draft` Star records its own, Studio must read the newest `.dev` row rather than the newest row, which belongs in that task.
- **The record from served bytes is unobservable in-lane.** The race it closes, a write to `dist/index.html` between the arrival check and the copy, cannot be produced through the build seam, so no test reds without it. It stays because the build version is defined as the digest of the page served.

### The deployed pass (2026-10-15)

The second pass ran on `a83690d`, the panel's fixed tree, and its Workers Issues were read afterwards.

**For Larry:**

- **Workers Issues showed a 500 older than this build, and it is fixed.** A scanner sent `GET /auth/login` with `content-length: 0` to the platform host. The Worker's forward there copied every request whose `body` was not null, and `new Request` refuses to copy a GET with a body: *Request with a GET or HEAD method cannot have a body*. The copy came in with `c1bb1b1` (2026-10-03). The forward now sends a GET or HEAD on without its body, which no browser sends.
- **The new scenario, `bodied-get-answers`, is container-free.** It sends a GET and a HEAD by raw `node:http`, with no body, an empty one and five bytes, and asserts each answers as the plain request. On the unfixed deployed Worker the empty body reds it, as the scanner's did. Locally only the five bytes do: before the fix, the local stack answered the empty-body GET 200, and where it loses that body was not traced. Dropping either method from the fix reds it.
- **Certificate validation stopped three of today's nine deployed runs, each before any of this task's code.** A new app's certificate pack sat in `pending_validation` through the whole six-minute wait. `dev-star-follows-the-build` hit it in the first pass and passed in the second; `dev-tab-frame` and `build-box` passed in the first, hit it in the second, and passed after the fix's redeploy. Today's stalls ran past the six minutes; `waitForHost`'s JSDoc expects two and a half to four.

**Retro:**

- Second pass: `dev-star-follows-the-build` passed in 418 s, all ten limbs, and `build-reaches-every-studio` in 302 s, all seven.
- Issues since the deploy: the bodied GET, four times, one of them the new scenario's red run; and the standing `scope-deleted`.
- After the fix, `test-nebula` redeployed at `df2e2b9`: `bodied-get-answers` passed, then `dev-tab-frame` in 192 s and `build-box` in 199 s. Issues since that deploy: `scope-deleted` alone.
- `first-app-built` ran again on that deploy, since the panel changed the reply fallback its turn reads: it passed in 271 s, its turn landing clean in 8 rounds with the fallback `Updated the preview.` `star-serves-current-ontology`, whose header the build reworded and whose builds land through the new path, passed in 200 s. Every scenario this build wrote or touched has now passed deployed on its final code.
- The closing Docker sweep's one guidance fail, limb (a) writing no `App.vue` after the panel shortened `TOOL_CONTRACT` and `mark_complete`, did not recur: two further local runs of `studio-guidance-loop` passed every limb. The lines are in `nebula-pre-alpha.md` § *Data-bound generation*.

**Close-out:**

- `routeDORequest` copies its request with `new Request(request, { headers })`. Nebula hands it only the body-less request `hostedUpgrade` builds, so a bodied GET cannot reach it here; whether it throws for one was not checked.
- Verified: `apps/nebula` 1083 passed; `drive.ts all --fast` 56 of 56 in 24.2 min, `bodied-get-answers` among them.

### The type check reads the real types (2026-10-15)

Larry's answer to the hand-off's first decision: keep holding back a build with findings, and check against the real types rather than a copy (§ *Decisions*).

**For Larry:**

- **The check now reads the app as vite builds it.** Its type pass builds a program from the app's own `tsconfig.json` and `src/`, the scaffold's `nebula.ts` included, with the `<script setup>` added as a file beside its `.vue`. Imports resolve on the build box's disk: `vue` and `lucide-vue-next` from the image's install, and `@lumenize/resources` from the source the Dockerfile already vendors. `apps/nebula/src/sfc-contract.ts` is deleted. The one shim left declares a `.vue` import, since tsc cannot read a component file.
- **The check reports only the model's file.** The client's type graph reaches Mesh's server files, such as `alarms.ts` and `auth-facade.ts`, which need Workers types a browser app does not load, so the rest of the program is never clean. Reporting every file red every clean case in the tests.
- **The import allow-list went with the copy.** It declared the icons and `@lumenize/resources/frontend` and nothing else, so importing any other package was a finding, which enforced `AGENTS.md`'s "Do not import any other package". Now an uninstalled package is still a finding, and fails `vite build` besides, but one the build box installs, such as `vite` or `daisyui`, resolves. The guidance still says it; nothing checks it.
- **A finding now names its line in the `.vue`.** Lines used to count from the `<script setup>` block, so a component written template-first got every finding several lines early. The block is padded down to where it sits.
- **The scaffold's `nebula.ts` lost a dead `@ts-expect-error`.** Its comment said the client import was unresolved in the image, but the Dockerfile vendors it and no program reads the file unresolved; once anything checked `nebula.ts`, the unused directive would itself have been a finding on platform code.

**Retro:**

- A throwaway probe settled the sizing before any code: against the real files, the taught app had no findings in 1.2 s, and `op: 'set'` and a misspelled `subscribeQuerry` each had one. The hand-off had called the work unsized because it assumed generating declarations; the box already held the real types.
- `checkTypeScript` gained three options rather than a second engine: a `DiskReader` it falls back to, a `tsconfigPath` whose options replace its defaults, and `reportFor`. The package still imports no `node:fs`; the build box's code passes the disk in. Type packages resolved only once the config's own path was passed, since TypeScript resolves `types: ["vite/client"]` from it.
- Two baseline files failed once each under full-suite load and passed alone four times: `resubscribe-on-signal.test.ts`'s rotation case, and `scope-isolation.test.ts`'s T-local-skip, which `testing.md` already names. A third full run was green. Neither touches the check.

**Close-out:**

- `codegen-gate.test.ts` moved from the `dev-studio` project to `offline`, which has a disk; the offline scorer calls the build box's `checkVueSfc` on the scaffold app, so the two can no longer drift. Its `Phase 1` describe names went, as task handles in source.
- `backlog.md`'s row on deriving the contract is closed. `nebula-pre-alpha.md`'s Vapor item no longer lists the contract, and `/build-task`'s new example says the check now reads the real types.
- Verified: `packages/ts-runtime-parser-validator` 214 passed; `apps/nebula` 1088 passed (1083 + 5); seven mutations of `sfc-check.ts` and three of the engine, each red on its own test; `drive.ts all` with Docker, 67 of 67 in 55.4 min, on an image rebuilt with the new check.

## Phase Retro

1. **What did we learn?**
   - **Holding back on findings turns every gap in the type checker's contract into a correct app kept off the preview.** Findings were advisory before, so the contract's missing `subscribeQuery`, `*.vue` module and `Symbol.dispose` cost nothing; under a held-back default each one gated a build. Limb 8's list app found the first, the verifier panel the rest. The check now reads the real types (§ *The type check reads the real types*).
   - **A create at a fresh id reaches its subscribers only through the query rerun**, which takes no originator, so the content broadcast's originator cannot matter to a `ServedBuild`.
   - **An `AsyncLocalStorage` store set around a turn follows its build through the landing queue,** because a promise reaction keeps the context it was registered in; a direct `buildNow` arrives on its own request and never sees it.
   - **The frontend package is vendored into the build box's image**, so a mutation of it rebuilds the image and reaches the built app, which made frame-side mutations runnable through `/live`.

2. **What did we struggle with?**
   - **Three of nine limb mutations survived on their first run, all for timing in the scenario rather than in the code:** a mark on the iframe's first `about:blank`, a reload that beat limb 3's mark, and a reap line from another tab. Each fix built the shape the limb was about, and two became rules in `live-scenarios.md`.
   - **The gates are long.** Two full Docker sweeps of about 37 minutes, a `--fast` sweep of 25, about forty single-scenario runs for mutations, and a deployed pass.

3. **Did any tests fail unexpectedly?**
   - Phase 1's suite: two files the phase did not touch encoded the old reply and `why` strings.
   - Phase 1's scenario: limb 8's list app was held back, by the SFC contract's missing `subscribeQuery`, not by its own code.
   - The verifier panel's fixes: limb 10's new barrier check could never pass, because the previewed rebuild of the held-back source has the held-back build's digest; the Wipe mutation run exposed it.
   - Deployed: three runs stopped at sign-up on a certificate pack left `pending_validation` past six minutes, Cloudflare's side.
   - Deployed, in Workers Issues rather than any scenario: a scanner's GET with an empty body 500'd at the platform host's forward, a defect from 2026-10-03 that no lane sent.

4. **Impact on follow-on work?**
   - Personas can pace its strip by `ServedBuild` values and the frame's echo, both built here.
   - `nebula-agent-posts-as-itself.md` keeps `pinnedAtDoor` and `actor`, with the landing as their caller.
   - A `.draft` Star must make Studio read the newest `.dev` row rather than the newest row (its backlog row says so).
   - A backlog row for a public Mesh seam to run in-DO code under a call context. The row on deriving the SFC contract closed in this build, when the check moved to the real types.

5. **Process changes?**
   - Two rules added to `live-scenarios.md`: a wait for one client's line matches its id, and a mark on a frame waits for the frame's own document.
   - Added to `/build-task`'s implement step: when a phase turns an advisory signal into a gate, as Phase 1 did for type findings, run what the docs teach through what the gate reads (here the SFC contract) before the phase closes. It would have found the contract's gaps in Phase 1 instead of at the panel.
