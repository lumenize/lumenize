# The Universe gets a Resources plane, and a name to put in it

**Status:** Pass 1 — design intent only, phases NOT written. Drafted 2026-09-21 while auditing the
Galaxy's `@mesh` surface, where deleting the config pair left the Universe with nothing at all.
It follows [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md) and lands before
the wipe (Larry, 2026-09-29). That build's claim takes slugs only, so this one adds the names to the
claim in the same change that stores them, and no name is ever parked on `Scopes`.

**Objective — a Universe holds resources the way a Galaxy and a Star already do, and the first thing
it holds is the account's own name.**

`universe.ts` is twenty lines: a `setUniverseConfig`/`getUniverseConfig` pair over an untyped
`Record<string, unknown>` in KV, and nothing else. The Galaxy and the Star carry the same pattern, and
[nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) handed all three pairs to this file (its D11), so retiring them leaves this class empty. Meanwhile
[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Scope full names* records that a Universe "has no human
name anywhere, and its slug is doing two jobs at once", and this build is where the signup starts
collecting one.

## Relationships

- **Follows [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md), built 2026-09-28.** That task
  settled the gate shape and moved every guard into the plane; this one composes the same plane onto
  a third host and inherits the finished contract. ⚠️ **What it
  settled is TWO accessors, not one** (2026-09-21): a `@mesh() get resources` door and a
  decorator-less `get resourcesResults` reached only on the response leg — both GETTERS — each
  returning a narrow facade rather than the plane. Read § *The surface, allocated* for the member lists; the Universe
  supplies both, and the door is still the only `@mesh()` entry.
- **It also inherits RETIRING THE THREE CONFIG PAIRS** (handed over 2026-09-22; that task proposed
  the deletion and the scope was cut to here, because this is the file that authors their
  replacement). `setUniverseConfig`/`getUniverseConfig` and the Galaxy and Star pairs all go when the
  scope-metadata Resource lands — one blast radius rather than two. **Two preconditions, both
  measured rather than assumed:**
  - **`coalesceWindowMs` needs a home FIRST.** `Snapshots`, the storage engine, bootstraps it into the same `'config'` KV
    bag and reads it on every write to decide snapshot coalescing, and `setStarConfig` is its only
    setter — so the Star pair is not a probe surface and cannot simply be deleted. A constant, a
    plane accessor, or a field on the new type.
  - **Three `/live` scenarios and four frozen test lists read these methods**, and
    `passage-not-dominion` loses one in all three limbs, including the `getStarConfig` positive
    control whose own comment records that it is not optional. Name the replacement each limb
    re-points at, and make `drive.ts all` a phase criterion rather than a follow-up.
- **Follows [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md), and adds names
  to the claim that build rewrites** (Larry, 2026-09-29). That build's claim writes a universe, its
  first galaxy and that galaxy's `.dev` Star, and takes two slugs. This build adds the account's and
  the first app's names to both claim paths, and writes each as a scope-metadata resource on its host,
  so no name is ever parked on `Scopes`. [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Scope full
  names* still plans a `name` column there, and the subdomain build's Phase 8 corrects it.
- **No wipe dependency of its own**, though a name written before the wipe goes with everything else.

## Context and current state

**`universe.ts` in full, today** — the whole class:

```ts
export class Universe extends NebulaDO {
  @mesh(requireDominionHere)
  setUniverseConfig(key: string, value: unknown) { /* KV blob */ }

  @mesh()
  getUniverseConfig(): Record<string, unknown> { /* KV blob */ }
}
```

- **`Galaxy` and `Star` each compose `Resources`** with four arguments — `ctx`, a thunk
  returning the host's `lmz`, an ontology provider, and an optional post-commit hook. *Adapted:*
  [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) collapsed the six
  it had into these (its D22): the plane sends every update and fans out its own orgTree changes
  through the handle — every plane has an orgTree. So the Universe supplies at most four, and has
  no fan-out to write.
- **A platform ontology is authored in code and precompiled before deploy.** `chat-constants.ts` is
  the input, `scripts/gen-validator-seeds.ts` emits a committed row into `validator-seeds.ts`, the
  package `test` script runs that generator with `--check` ahead of vitest so a drifted literal reds
  the suite, and a Galaxy installs the row on first touch — "no Worker ever runs the compiler for
  it". *Carried over:* a scope-metadata ontology follows that exact path, as its second instance.
- **`.universe/` is already reserved in the codegen loop's path rules**, answering
  `'.universe/ is reserved — no Universe layer exists yet'`. *Left as is by this task*, and named
  because it is the other thing a Universe will host; giving the Universe a plane does not build it.
- **The Registry owns scope existence, not scope content.** `Scopes` is one column, a primary key,
  whose JSDoc says its four readers are slug uniqueness, parent-exists, enumeration and the deletion
  cascade — "none of them is access control". *Carried over unchanged:* a display name is content,
  so it belongs with the scope's own resources rather than in that table.

## Design intent

**The Universe composes the plane and exposes one door, exactly as the other two hosts do** — no
`@mesh()` method per operation, per [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md).
The config pair goes; nothing replaces it, because an untyped key-value blob is what a typed resource
is for.

**The first type it holds is the account's display name**, with room for a logo and a description
beside it. Written by an admin with dominion, readable by anyone with passage, subscribable so a
rename reaches every open page rather than waiting for a reload
(`.claude/rules/nebula-prefer-subscribe-for-live-ui-data`), and versioned by
[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) so a rename has history.

**One ontology serves all three tiers, because the question is the same at each.** A Star and a
Galaxy want a display name too, and the Galaxy half of that is the successor to `setGalaxyConfig`,
which [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md)'s D11 handed to this file. Authoring one scope-metadata type and installing it on every host that composes a
plane is cheaper than three near-identical ones, and it makes "what is this scope called?" one
question with one answer shape.

## Open questions

- **Does the Universe need an `OrgTree` at all?** The plane brings one, and on a Star it carries the
  org tree the whole permission model reads. A Universe's resources may be adequately governed by
  passage and dominion alone, in which case the DAG is composed but unused — carried for uniformity,
  or a reason to split the plane so a host can take resources without a tree.
- **Where does a Star's display name live?** A Star composes the plane, so it can hold its own. But a
  tenant Star's name may belong to the app that provisioned it rather than to the tenant, which is a
  product question rather than a placement one.
- **Is the scope-metadata ontology one type or three?** One `Scope { name, logo, description }`
  installed everywhere is simplest; per-tier types would let a Galaxy carry fields a Star has no use
  for. The second is only worth it if such fields exist — name one before splitting.

- **How does a name get from the claim to its host?** The claim runs in the Registry, which speaks no
  mesh, and holds no token, since claiming is how a person comes to hold one. The account's name
  belongs on its Universe and the first app's on its Galaxy, and the claim touches neither. The
  consume, which wakes the Galaxy to order its certificate pack, is one moment both hosts could be
  written; carrying the names on the claim's record until the first page loads is another.

## Constraints

- **[ADR-001](../docs/adr/001-typescript-as-schema.md):** the type is TypeScript, compiled
  by the existing generator. No second schema language, and no runtime compile for a platform input.
- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) and
  [ADR-006](../docs/adr/006-resources-reference-by-id.md)** apply unchanged — a rename is a new
  snapshot, and a reference to another scope is an id.
- **The generator's discipline comes with the ontology:** a changed literal requires a bundle-id bump
  beside it, because the Worker Loader caches by id.
- **No behaviour is added to the Universe beyond the plane and its first type.** Billing, the
  `.universe/` guidance layer and a universe-level org tree are named here only so a reader knows
  they are not in scope.

## Criteria to carry into the phases

A draft. Run every instrument before writing it down, derive every enumeration, and give each
criterion a fixture, a mutation and a positive control.

- **A Universe holds a resource.** An admin writes the account's name on the universe page and a
  second page subscribed to it sees the new value without reloading. Mutation: drop the subscribe
  fan-out and the second page keeps the old name until it reloads.
- **A name is written by dominion and read by passage.** A member of a galaxy beneath the universe
  reads the account name; a member of another universe is refused, matched by message. Mutation:
  widen the read to any authenticated caller and the second read succeeds.
- **The Universe exposes one door.** Derive the Universe's mesh entries with `meshEntries(Universe)`
  (`apps/nebula/test/test-apps/mesh-surface.ts`), which walks the whole prototype chain and so sees
  the inherited `NebulaDO.teardown` a `grep` of `universe.ts` misses; `scope-isolation.test.ts`'s
  Universe row freezes it today. The phase names the expected set by symbol. Mutation: re-expose a
  resource operation on the host and the set grows. ⚠️ `resourcesResults` carries no decorator by
  design, so it never appears there, and a separate assertion owes that absence — read off the
  DESCRIPTOR, since reading `Universe.prototype.resourcesResults` invokes the getter where the
  `#resources` brand check throws: `isMeshCallable(d.get ?? d.value)` is false for
  `d = Object.getOwnPropertyDescriptor(Universe.prototype, 'resourcesResults')`, with the positive
  control that `d.get` is a function, as `resources-door.test.ts` does for the Star and the Galaxy.
- **The config pairs are gone and nothing lost a guard.** Every `/live` limb that read a config
  method reads its replacement instead and still discriminates by message, and `coalesceWindowMs`
  survives the deletion with a named home. Mutation: delete the pair without re-pointing a limb and
  `drive.ts all` reds rather than a scenario silently losing its control.
- **The scope-metadata ontology is precompiled and drift-checked.** The generator's `--check` runs
  ahead of vitest and reds on a hand-edited literal, as it already does for the chat seed.
- **No Worker compiles it.** Mutation: install the type from source at first touch and the boot
  profile shows the compiler running.
