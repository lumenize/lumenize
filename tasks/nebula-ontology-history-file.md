# The ontology history is one committed file

**Status:** Design intent only, phases NOT written — **follow-on #2 to the Galaxy collapse** ([nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)), after [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md), **before the pre-alpha wipe**. Scheme settled with Larry 2026-08-24; the sequencing is § *Why this timing*. **Migrations are AUTHORED under this design but EXECUTED post-pre-alpha** — the walker is a later task.

**Objective: the ontology's whole history — every version's label, types, and migration — lives in ONE committed file in the Workspace repo, and the latest version always carries all of it.** Reading the file top to bottom IS reading the schema's evolution, which is what makes writing migration *n* easy: every prior shape and every prior migration is in the same read.

## The scheme

- **The file is the registry; git merely versions the file.** Ordered entries `{ label, types, migration }` — array position is the order, the same index-array idea the KV registry uses today, relocated into the tree. Labels stay free-form (`/^[A-Za-z0-9-]+$/`), human/LLM-chosen; ordering never depends on label sortability.
- **`migration` is REQUIRED from the second entry on, even though nothing executes it yet.** It is written at schema-change time, when the knowledge is fresh, and executed by the post-pre-alpha migrations task. Its exact signature is that task's to refine; its presence is not.
- **Append-only is enforced at ONE chokepoint, covering both writers.** Every write lands through the Galaxy (the Studio LLM writes via `ws.fs.writeFile`; the commit is Galaxy code). At that write path: parse HEAD's copy, parse the new one, and **require the old entries to be a byte-identical prefix of the new** — edits and reorders of history are rejected before they can land. The LLM's rejection rides the loop it already knows (the error tail, like a compile error); our code hits the same validator plus tests. ⚠️ This guard ships in THIS task, not with the walker — history must accrete correctly from the first post-structure version.
- **What git contributes is only what git does:** history of the file, blob dedup (a hundred code-only commits reference one unchanged ontology blob — nothing is re-stored), and the refs (the shipped ref and release tags belong to the published tier, [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 5*).
- **What dies:** the KV registry as truth — `INDEX_KEY` + per-label rows — and the four mesh methods `appendOntologyVersion` / `listOntologyVersions` / `getLatestOntologyVersion` / `getOntologyVersion`. It is all files in a git repo now.
- **What stays:** Star's `ontology:{label}` install rows (a cache of an install — a Star cannot read the Galaxy's git); the `meta.ontologyVersion` stamp on every snapshot; the served shell's version derived from the served tree, never stored separately.
- **One convention, two repos:** the user app's ontology evolves in the **Workspace** repo under this scheme; the platform's chat ontology lives in the **platform** repo (`devstudio-resource-ontology.ts` — it exists so chat could reuse the Resources plane) and installs as one seeded version. Not two substrates — two repos.

## Tabled here, decided here: compiled-validator storage

Deliberately parked (Larry, 2026-08-24) — complicated enough for its own pass, and entangled with this task rather than the collapse: the **Star-fetch path** rides the same mesh methods this task deletes, so its successor is this task's to design. Open: where compiled validator bundles live (a Galaxy compile-cache keyed by label is the candidate — a cache, never truth, recompilable from the file), and how a Star's install fetch works once the registry methods are gone. Settle before this task's phases are written.

## Why this timing

- **The collapse runs entirely on today's machinery — verified per phase.** Phase 1 needs only a working ontology (the code constant). Phase 2's uniformity gate installs via today's `appendOntologyVersion` → KV path, and everything it builds is substrate-agnostic and survives this task: the client's real version, the bundle-id derivation, the `SESSION_MESSAGE_BUNDLE_ID` deletion. What this task replaces — the KV registry as truth — already exists, so the collapse carries no new interim.
- **Before the wipe, because the substrate swap is free only while wipe-freely holds.** Re-homing truth with no live data is a swap; after real users it is a live-data migration of the registry itself. (The cold-start experiment's § *Now what?* makes the same argument for DO splitting: migration cost is not flat over time.)
- **Migrations execute post-pre-alpha, and the wipe is what makes that safe:** it resets every snapshot to the then-current version, so the first execution is needed only when a LIVE app's ontology changes — after pre-alpha by definition. Authored now, executed then, nothing lost.
