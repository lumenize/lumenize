# ADR-024: Two Versions Keep an App's Page, Types and Data in Step

**Date**: 2026-10-11
**Status**: Proposed
**Deciders**: Larry
**Evidence**: The ontology version check every data-op a Client sends passes, `Resources.#gateClientOp` (`packages/resources/src/resources.ts`); the Star's fetch of its Galaxy's current row (`star.ts`'s `#ontologySource`), and the Galaxy's answer by kind (`galaxy.ts`'s `getCurrentOntology`); the Client's one decision on a stale answer and its reload guard (`client-resources.ts`'s `#handleStale`, deciding through `stale-decision.ts`'s `decideStale`); the digest a build reports for the page it produced, which is its build version (`build-report.ts`'s `bundle.indexSha256`); the `ontologyVersion` every snapshot records (`snapshots.ts`); what a promoted validator can reach: the build job, which compiles it and then runs the app's own `vite build` in the same container (`apps/nebula/container/compiler/job.ts`), the per-Galaxy key a tenant Star loads it under (`star.ts`'s `bundleId`), and its sandbox with no network (`facet-helper.ts`'s `globalOutbound: null`). The finding of 2026-10-10 that no product path applied an ontology, so every real preview ran with no data types, is in [nebula-star-ontology.md](../../tasks/archive/nebula-star-ontology.md).

## Context

**An app built in Studio is three things that have to agree: the code a browser runs, which this ADR calls the page once it is loaded; the data types the Star checks writes against, with everything derived from them; and the data itself.** Jennifer adds `dueDate?: string` to `Deal`. The page that writes a due date, the validator that accepts one, and the `Deal`s already stored must line up. Otherwise a write is refused, a read shows a field the page has never heard of, or a validator accepts what the page cannot render.

Each of the three holds a version:

- **The page** carries the *ontology version* of the data types it was built against, and the *build version* of its own code, both written into it by the Galaxy that serves it.
- **The Star** has one ontology version installed: the compiled form of `src/ontology.d.ts`, which it validates every write against.
- **Each resource** records the ontology version it was last written at, in its snapshot.

**And there are two kinds of Star.** A Galaxy's `.dev` Star runs what is being developed, and its data is test data. A Star with real users runs what was published, and its data is the tenant's.

The rest of this ADR takes each version in turn: what it names, who chooses it for a Star, and what a page does when its own is not current. Then it says what a publish ships and which way data moves.

## Decision

**An app has two versions: an ontology version, which decides whether a data-op runs, and a build version, which moves a page onto newer code.** On a Star with real users, data moves only forward. On a `.dev` Star, the test data is wiped and seeded again at the new ontology version.

### The ontology version decides whether a data-op runs

**It is the content hash of `src/ontology.d.ts`, such as `3f2a9c…`, and it names one shape of data:** the types, and everything derived from them, which is the validator and the index columns a Star copies fields into so it can query them. Two builds that leave the ontology alone share an ontology version.

**A Star runs one ontology version at a time, the one its Galaxy calls current.** A Galaxy's `.dev` Star runs its last previewed build's, and a Star with real users the latest published one.

**Every data-op a page sends carries the page's ontology version, and runs only if it equals the Star's.** Otherwise the op does not run at either version: the Star moves itself to what its Galaxy calls current, and a page that still does not match reloads, bringing the app up to current.

### The build version moves a page onto newer code

**It is the digest of the `index.html` a build produced, such as `9c41e0…`, and it names the page's code.** Vite puts a hash of each file it bundles into that file's name, such as `assets/index-4f3a2b1c.js`, and `index.html` loads each one by that name, so its digest changes whenever the code does. It is known when the build lands, needs no commit, and needs no counter.

**A Star's host serves the build its Galaxy calls current, the one whose ontology version the Star runs.** When a page learns its build version is no longer current, it reloads onto that build. It reloads at most once from one build to another, so a reload that brings back the old page, from a stale cache say, does not start another, while a page that has since moved to a third build reloads again.

**So the two versions move apart.** Jennifer adding `dueDate` to `Deal` moves both. Changing the Save button's label moves only the build version: pages move onto the new code, and the Star installs nothing.

### A publish ships both versions, and a migration

**Publishing is an explicit step:** the user-developer and Studio's agent decide a build is worth shipping. A publish promotes a build whole, validator included, so it carries that build's two versions, and adds one thing a build lacks: the migration from the ontology version published before it. A publish can promote the very build the `.dev` Star runs, and the two Stars then run the same versions until the next build.

### Which way data moves

**On a Star with real users, data moves only forward.** It is migrated to the ontology version a page runs, by the user-developer's migration code, which runs sandboxed as the validator does. Nothing migrates backward, and a page never receives data at a newer ontology version than its own; it reloads instead.

**Migration is the one step that needs an order.** Neither version has one: both are content digests, and every step above needs only equality and what the Galaxy calls current. Carrying a resource from the ontology version it was written at to the one a page runs means knowing which migration steps to run, and in which sequence. So a publish records the published ontology versions in order, each with its migration from the one before.

**On the `.dev` Star, data that no longer fits is wiped whenever necessary.** It is test data, so it sits outside [ADR-004](004-snodgrass-temporal-resources.md)'s history: a wipe drops it, and a revert can make an older ontology version current there.

> **Today's code differs.**
> - No Star copies a field into an index column yet, so the validator is all an ontology version derives.
> - The tenant Stars of one Galaxy share a validator cache entry per ontology version; the `.dev` Star keys its own.
> - Nothing is published, and no migration exists.
> - Every page carries its build version, and a build that changes only code reaches every Studio on the app. A page in a tab of its own does not learn of it.

### Deliberately open

- **How a publish records and orders its ontology versions,** and where each published validator and migration lives. A git tag per published version and a Galaxy compile-cache are the candidates, in [nebula-pre-alpha-fast-follow.md](../../tasks/nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path*.
- **When migration runs:** when a resource is read, in a sweep after a Star installs an ontology version, or both, and what a query sees over rows nobody has read since a publish. Migrating on read, one published ontology version at a time, is the candidate in the same section.
- **How a Star builds the index columns an ontology version adds:** at install, and filled for existing rows by the same forward migration, is the candidate.
- **Which other Stars follow the build as `.dev` does.** An environment Star with no real users, `test` say, could; until one does, every Star but `.dev` runs a published build.
- **How a published Star's pages are kept from being served while a build's output is still arriving.** `.dev` serves only a copy made once a build is previewed, `index.html` written last and the ontology row right after it, as a published Star serves only `dist-prod/`. What stays open is how a publish makes that copy.
- **How and when a page learns its build version is no longer current.** On `.dev`, every Studio on the app learns the landed build from `.dev`'s `ServedBuild` and asks the frames it holds to reload, and each frame decides by its own build version ([nebula-testing-with-personas.md](../../tasks/nebula-testing-with-personas.md) will pace the tabs it frames). What stays open there is a page in a tab of its own. On a Star with real users it stays lazy or is spread out, so one publish never reloads every tab at once.
- **What happens to an end user's write in flight when a change of either version reloads their page.** Sending it again after the reload is not enough, since the old page built it for the old types.
- **How a published Star spreads the reloads** when one install tells every open tab at once ([nebula-pre-alpha-fast-follow.md](../../tasks/nebula-pre-alpha-fast-follow.md) § *Item 5*).

## Alternatives considered

- **A Star installs the ontology version a page names.** It hands the choice of version to whichever tab acts first, including one served before the last publish.
- **Checking only the data-ops that name an ontology version.** Three data-ops named none, so a page's list ran at whatever version the Star held, and once a page stopped reloading on every notice it would have stopped updating after a build (the review of 2026-10-11).
- **The Galaxy pushes each new ontology version to every Star** (2026-07-25). A Star that pulls converges only when a tab asks, so a Star nobody is using costs nothing.
- **One version for both the types and the code:** a git commit, a counter, or a published-and-dev pair. Every code-only build would then look like a new shape of data. The Star would install identical types under a new key, every open page's next data-op would be refused and asked again, and each resource would record versions with no change of shape between them. A commit also does not exist yet when a build runs.
- **The ontology version alone.** A build that changed only code would reach no open page, and a page whose bug writes valid but wrong data would go on writing it.
- **Ordered versions, so a Star could tell a page that is behind from one that is ahead.** Order is needed only to migrate, and only published ontology versions migrate; a content digest needs no counter anyone has to coordinate ([ADR-010](010-random-opaque-keys.md)).
- **Migrating data backward for a page on an older ontology version.** Reloading the page costs one round trip and loses nothing; a backward migration has to be written and can lose information.
- **Compiling a published validator where the app's own code cannot reach it,** by reading it back before a build runs any of the app's code, or by compiling again at publish. Either guards a door the page already leaves open (§ *Consequences*), and the second ships a validator the `.dev` Star never ran.
- **Keeping a compiled row for every build, or a history entry per build.** Data on the `.dev` Star is wiped rather than migrated, so nothing would read them (Larry, 2026-10-10).

## Consequences

### Positive

- **The preview runs the last build the model previewed,** with no step for anyone to take.

### Negative / mitigations

- **A build the model holds back is served nowhere until the model previews a build.** A turn that ends on one says so in its reply, and building again with `{ "preview": true }` lands it.
- **Test data that no longer fits stays on the `.dev` Star until it is wiped and seeded again,** and the preview may misbehave on it until then. Studio's agent says when a change breaks existing data, and asks before it wipes.
- **The app's own `vite.config.ts` runs beside the compile, so it could swap the validator a publish promotes.** That risk sits with the user-developer, directly or through their trust in whomever they invite to work on the app. Those same people can already change the page, which acts as every end user with that user's own access. The validator runs with no network, keyed to its own Galaxy, so the most a swapped one can do is let wrong-shaped data into that one app's Stars, where a forward migration can repair it.
- **A reload loses what the page held only in memory,** such as a half-typed draft. [ADR-017](017-the-url-is-the-view-state.md) keeps the view in the URL, so the reload lands on the same view.
- **Until something is published, a Star with real users runs no data operation at all.** Before alpha their pages answer 404, so no user sees it.
