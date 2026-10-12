# A page knows which build it runs

**Status:** Pass 1, drafted 2026-10-12; phases not written. Larry answered its first open question the same day; its second waits on [mesh-client-calls-survive-a-reload.md](mesh-client-calls-survive-a-reload.md), which builds first. The `.dev` half of [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)'s build version. It absorbs fast-follow Item 8 and builds before personas, whose tab pacing runs on it.

## Objective

**After a build lands, every page on the app's `.dev` hosts moves onto it once: Studio reloads the preview frames it holds, and a page in a browser tab of its own reloads itself when it next comes into view [or potentially on next data-op, right?].** Each page carries the build version it was served, and that version never decides whether a data-op runs.

After Jennifer changes the Save button's label and the build lands:

| Page | Today | After |
|---|---|---|
| Jennifer's Studio, which asked for the build | Its preview reloads | Its preview reloads |
| Austen's Studio, open on the same app | Keeps the old label until Austen asks for something | Its preview reloads |
| `mary--dev.crm.acme.lumenize.dev`, a persona's host in a tab of its own | Keeps the old label until someone reloads it by hand | Moves onto the new build when Austen next switches to it |

## Context

**ADR-024 gave every page two versions, and only one of them works yet.** The ontology version works end to end: a build that changes the types reaches every page that holds a subscription, because the Star's install tells each of them ([nebula-star-ontology.md](archive/nebula-star-ontology.md)). The build version exists only as a digest the build job reports. So a build that changes only code reaches whoever asked for it, and a collaborator watching the same app, or a persona's page in another tab, keeps running code that no longer exists. The ADR's *Today's code differs* says exactly that.

**Personas is why now.** It puts several pages of one app on screen at once, a tab per persona in Studio and each persona also on its own host, and it paces their reloads after a build: the tab in view at once, each other loaded tab the next time it comes into view ([nebula-testing-with-personas.md](nebula-testing-with-personas.md) § *Decisions*). That pacing needs a signal that reaches every Studio on the app and names the build that landed. Fast-follow Item 8 already planned the first half, the fan-out to every Studio; this task takes it over.

The rest of this file says what each page needs, what exists, and the contract the phases build against.

## Goals

1. **Every Studio on an app hears every build that lands.** Today `announceBuildToRequester` tells only the client whose build it was, so Austen's preview keeps the old code until her own next request.
2. **The signal names the build.** Today Studio's `handlePreviewReady(scope)` carries only a scope, so nothing can tell a frame loaded before a build from one loaded after it, which is the difference personas' pacing turns on.
3. **A page in a tab of its own moves onto a newer build, once, without losing a write.** Today nothing reaches it: it reloads when its ontology version changes, or by hand.

## Relationships

- **Gated by nothing open.** ADR-024 is committed, and [nebula-star-ontology.md](archive/nebula-star-ontology.md) is built.
- **Gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md).** Its strip reloads frames on the push Goal 2 names.
- **Absorbs [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 8: Tell the OTHER collaborators a new build landed*.** Its roster and its two warnings carry over, into § *Current state* and § *Design intent*.
- **Sits beside [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md).** Neither gates the other, and whichever clears review first builds first.
- **Hands the published half to fast-follow Items 4 and 5,** as a paragraph in each.

## Current state

Built already, each with its fate:

- **The digest a build reports.** The job hashes `dist/index.html` into `bundle.indexSha256`, and `Galaxy.#distArrived` checks the arrived file against it before a build lands. *Carried over:* it is the build version, and the `index.html` the Galaxy serves after a landing hashes to it.
- **The `nebula-scope` meta.** The Galaxy's serve path writes `dev`, `parentOrigin` and `ontologyVersion` into every HTML page it serves, and `createNebulaClient` reads it. *Adapted:* it gains the build version.
- **The requester's push.** `announceBuildToRequester` hands the requester's address to `deliverPreviewReady`, a one-way call to `StudioClient.handlePreviewReady(scope)` whose `onErrorOnly` handler logs a lost delivery. Studio's `onPreviewReady` then reloads the preview frame (`App.vue`). *Adapted,* as § *Design intent* says.
- **The roster.** `Resources.streamProgress` already sends to the chat query's subscribers who may read the chat node, one entry per open tab, and Studio subscribes to that query whenever it opens an app (`openChatThread`). *Carried over* as the list of who has the app open, as Larry settled for Item 8 on 2026-08-28. Item 8 asks that the time to drop a closed tab be measured before relying on it: about 5 s by design, perhaps 30 s from a bug.
- **The ontology version's reload guard.** `decideStale` and the `lmz.ontology-reloaded-for` key in `sessionStorage` reload a tab once per ontology version, through the app's `onShouldRefreshUI`. *Unchanged,* and the model for the build's guard.
- **`announceBuildToRequester`'s JSDoc,** which argues a fan-out would need a registry someone has to enrol in, maintain and reap. *Left behind:* the chat query's subscribers are that registry, and nobody enrols in it.

## Design intent

- **A page's build version is the digest of the `index.html` it was served, and the Galaxy writes it into that page.** It goes in the `nebula-scope` meta beside `ontologyVersion`, computed from the file the Galaxy is about to serve rather than stored, so it names exactly what the page received, even while a build's output is still arriving.
- **A landing tells every Studio on the app, and names the build.** The push that reaches the requester today goes to every subscriber of the chat query who may read the chat node, through the same targets `streamProgress` uses. Studio reloads its preview frame on it, and personas later paces its strip by it. A Studio is on the list because it shows the chat, so none can forget to join.
- **Studio decides when the frames it holds reload.** A page Studio frames leaves its reloads to Studio, so pacing has one home.
- **A page in a tab of its own checks its build at the moments it could have missed one.** When it comes back into view, and when its connection comes back, it asks its own host which build it would serve now, and moves if that differs. A data-op refused for an old ontology version moves it too, by the reload that refusal already causes, because a new ontology version lands only with a new build.
- **It moves once per build version.** What becomes of a write still pending when it moves is § *Open questions*. The reload goes through the app's `onShouldRefreshUI` with a reason naming the build, so an app can show a banner instead, behind a guard that records in `sessionStorage` the build version it reloaded for, as the ontology reload's does.
- **The build version never rides a data-op.** The Star never sees it, so a code-only build refuses nobody's write and the Star installs nothing for it (ADR-024).
- **An ontology change still reaches every subscribed page at once,** through the Star's install notice, because a page on the old types cannot run a data-op on the new ones. Only a build that changes code alone waits for Studio's pacing or the page's own move.

## Constraints

- [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md): two versions compared by equality, a reload once per build, and the build version never decides whether an op runs.
- [ADR-017](../docs/adr/017-the-url-is-the-view-state.md): a reload lands on the same view, because the view rides the URL.
- [ADR-003](../docs/adr/003-continuation-messaging.md) and `mesh.md`: the push stays a one-way call whose handler hears only a failed delivery.
- `live.md`: a `/live` scenario first. The change is to what Clients hear, so the close-out runs a deployed pass of the scenarios it writes or touches.
- `studio-guidance.md`: `preview` stays the build tool's word, and nothing in the model's tool path changes.
- Milestone: pre-alpha, before personas. It changes no stored shape, so it rides the deploy.

## Future state

- **The published half.** A published Star's pages carry the build version the same way, from the copy a publish promotes, and fast-follow Item 5 keeps a publish free of any reload push, so a published page moves only by its own check. ⚠️ Design consideration: a check that reaches the Galaxy grows with end users' activity on one Durable Object per app, so it wants a cache in front before alpha has users.
- **Personas' strip** paces its frames on the build the push names: the frame in view reloads at once, each other loaded frame when it next comes into view, and a frame loaded after the landing is already current. ⚠️ Design consideration: a framed page could tell Studio its build version over the channel it already posts its auth state on, so Studio never reloads a frame that is already current.
- **An environment Star that follows the build as `.dev` does** (ADR-024 leaves it open) gets the build version for free, since the Galaxy writes it on every serve.

## Open questions

1. **What becomes of a write still pending when a page moves onto a newer build?** A build that changes only code leaves every pending write valid. If [mesh-client-calls-survive-a-reload.md](mesh-client-calls-survive-a-reload.md) lands first, as planned, the reload carries them across and this file needs no rule of its own. Otherwise the page would wait until no write is pending, then reload. That rule is the stopgap the outbox deletes, so this question stays open until that file is decided.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **A page in a tab of its own checks its build when it comes back into view and when its connection comes back, and an ontology reload moves it too** (Larry, 2026-10-12). A persona's tab is usually out of view while the person asks Studio for the build, so it moves the moment they switch to it, the pacing personas wants for Studio's own tabs. The check is lazy, so the published half can share it with no reload push, as fast-follow Item 5 requires. A tab in view during a build keeps the old code until it is next hidden and shown, which test data tolerates. | **The landing telling the `.dev` Star, which tells every Client it hosts:** a tab in view would move at once, but Mesh would need a way for a node to reach every Client it hosts, which today only `ClientGateway.closeAll` does, and the published half would need a second mechanism. **Both:** two mechanisms to build and test for one property. |
