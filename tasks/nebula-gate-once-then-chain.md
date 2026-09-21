# Gate once, then chain — collapse the per-method `@mesh()` shims

**Status:** Pass 1 — design intent and an audit; phases are Pass 2. A short detour, taken because the
same fix has been proposed three times and deferred three times. `.claude/rules/mesh.md` § *Object-capability
access: gate once, then chain* and `.claude/rules/calibration.md` §11 carry the pattern; this file carries
the audit and what it costs here.

**Objective — a composed capability is reached through ONE `@mesh()` gate that returns it, so no host
re-exposes it method by method.**

`Galaxy` carries 22 `@mesh` decorators and `Star` about 20. Seventeen of Galaxy's are thin forwarders
into `this.#dataPlane`, and `Star` forwards into the same instance again. Immediately below them sits
`dagTree()`, doing it the other way, with a JSDoc that states the pattern: *"Single `@mesh()` entry for
the DagTree API (per-op auth inside DagTree)."* One class, two shapes, and seventeen of the twenty-two follow the wrong one.

## Relationships

- **A detour from [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md).** Its
  criterion on the upward arm enumerates these very methods, so whichever build lands second inherits
  what the first left. Landing this first makes that criterion a handful of members plus "per-op auth inside
  the data plane"; landing it second means writing the criterion against 22 and rewriting it after.
- **`calibration.md` §11 is about this exact decision** — where `invite` should live once `Star` and
  the collapsed `Galaxy` both compose `ResourceDataPlane` — and records the objection to the shims
  (Larry, 2026-08-21). It also explains why the fix keeps being deferred: `mesh.md` is path-scoped to
  source, so it never loads while the shape is being decided in a task file.
- **No wipe dependency.** Nothing here is stored data.

## Context and current state

**`dagTree()` is already shaped the right way, and is the model for the rest** — `galaxy.ts`:

```ts
/** Single `@mesh()` entry for the DagTree API (per-op auth inside DagTree). */
@mesh()
dagTree(): DagTree {
  return this.#dataPlane.dagTree;
}
```

Called as `ctn<Galaxy>().dagTree().setPermission(...)`. Only `dagTree` carries a decorator; every method
reached through it authorizes itself.

**Every other cluster re-exposes its capability method by method**, grouped here by what each forwards
into, with today's decorator:

| Cluster | Members | Decorator |
|---|---|---|
| Resource data plane | `transaction`, `read`, `subscribe`, `unsubscribe`, `subscribeQuery`, `unsubscribeQuery`, `subscribeQuerySubscribers`, `unsubscribeQuerySubscribers` | bare `@mesh()` |
| Membership | `invite` | bare `@mesh()` |
| Workspace and build | `writeSource`, `readSource`, `appendWorkspaceOntology`, `buildNow` | `@mesh(requireChatWrite)` |
| Ontology reads | `getCurrentOntology`, `getOntologyVersion` | bare `@mesh()` |
| Broadcast continuations | `onBroadcastResult`, `onQueryBroadcastResult`, `onQuerySubscriberListBroadcastResult` | bare `@mesh()` |
| Config | `setGalaxyConfig`, `getGalaxyConfig` | `requireDominionHere`, bare |
| Chat setup | `ensureChat` | `requireDominionHere` |
| Already a gate | `dagTree` | bare `@mesh()` |

`Star` repeats the resource cluster, `invite` and `dagTree`, and adds `subscribeTree`, `subscribeReload`,
`resetDevData`, `setStarConfig`/`getStarConfig` and four `on*BroadcastResult`.

**Nothing here is dead.** Every method probed on 2026-09-21 still has live callers outside its own
file — `subscribeQuerySubscribers` has 19. These methods are shaped wrongly, not unused.

⚠️ **`grep -c '@mesh()'` over-counts**, because the JSDoc in these files discusses `@mesh()` in prose.
Count decorator lines — `grep -nE '^\s*@mesh\(' <file>` — which is where 22 and 20 come from. A looser filter leaves a `//` comment in, which is how this file first said 23.

## Design intent

**One gate per composed capability, on every host that composes it.** `resources()` returns the data
plane the way `dagTree()` returns the DAG API, and the caller chains:
`ctn<Galaxy>().resources().subscribe(...)`. Only `resources` carries a decorator, so every
operation past it authorizes itself — which the data plane already does per-op for the DAG arm.

**Past the gate no decorator stands between a caller and a method, so each method owns its check.** `DagTree`'s gate says so on
the line, and the replacement must say it just as plainly.

**`invite` arrives by composition, not as a host method** — `calibration.md` §11's worked example.

## Open questions — the audit, for a judgement call on what remains

After the resource cluster and `invite` collapse into one gate, these are what is left on `Galaxy`.
Each asks whether the methods are grouped rightly, not whether they are needed; all have callers.

1. **`writeSource`, `readSource`, `appendWorkspaceOntology`, `buildNow`** — four methods, one decorator
   (`requireChatWrite`), one underlying thing: the Workspace. Is this a second gate — `workspace()`
   returning the Workspace API with per-op auth inside — or is the cluster too heterogeneous, given
   `buildNow` drives a container and `appendWorkspaceOntology` writes the registry?
2. **`setGalaxyConfig` / `getGalaxyConfig`** — a get/set pair with different guards
   (`requireDominionHere` on the setter, bare on the getter). Keep as a pair, or a `config()` gate?
   A pair is two methods and reads plainly; a gate would put the asymmetric guard inside.
3. **`getCurrentOntology` / `getOntologyVersion`** — "current" and "by label" differ only in an
   argument. One `getOntology(version?)` where absent means current, or does the pair earn its names?
4. **`onBroadcastResult`, `onQueryBroadcastResult`, `onQuerySubscriberListBroadcastResult`** — three
   continuation targets differing only in which table they reap. One method with a discriminator, or
   does mesh plumbing want to stay explicit so the continuation reads at its call site?
5. **`ensureChat`** — one caller. Is it API at all, or should it be internal to the first chat write?
6. **`dagTree()` and `resources()`** — two gates, or does the DAG arm belong behind `resources()`,
   since `dagTree` is reached as `this.#dataPlane.dagTree` anyway?

⇒ **Answering 1–6 decides whether `Galaxy` ends at about 11 methods or about 6.** `Star` follows the
same answers, plus its own question about whether `subscribeTree` and `subscribeReload` are a third
cluster or belong with the resource gate.

## Constraints

- **`.claude/rules/mesh.md` § *Object-capability access: gate once, then chain*** spells out how a gate
  is written and what a method past it owes; this file does not restate either.
- **[ADR-007](../docs/adr/007-shared-node-security-core.md):** the comms and guards core is shared by
  composition. A gate returning a composed instance applies that principle to what a host exposes.
- **The client changes with it.** `nebula-client.ts` and the scaffold call these by name, so every
  call site chains through the gate instead.
- **No behaviour change.** Every authorization outcome before and after must be identical; this moves
  where the check lives, never what it decides.

## Criteria to carry into the phases

A draft. The three rules in the sibling file's criteria section apply here too: run every instrument,
derive every enumeration, and name a fixture, a mutation and a positive control per limb.

- **One gate per capability, derived rather than listed.** `grep -cE '^\s*@mesh\(' apps/nebula/src/galaxy.ts
  apps/nebula/src/star.ts` returns 22 and 20 on 2026-09-21; the phase records what it
  returns after, and the expected set is named by symbol. Mutation: re-expose one data-plane method on
  the host, and the count rises by one against a named set.
- **Every method past a gate authorizes itself.** For each operation the gate exposes, a caller without
  the grant it needs is refused inside the capability, matched by message. Positive control: the same
  caller with the grant succeeds. Mutation: drop a per-op check and the refusal becomes a success.
- **No authorization outcome changes.** The existing suites that exercise these methods pass unchanged
  once their call sites chain through the gate — the churn is mechanical, per `calibration.md` §3(c).
