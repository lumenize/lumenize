# Tenant-Scoped Helper DO Naming — `<scope>:<local>`

> 🧊 **Iceboxed 2026-06-22.** No consumer — Fix 2's only caller (the now-removed `ResourceHistory` test fixture) is gone and the Think consumer is shelved. Revive when a real tenant-scoped helper DO with a production caller lands.

**Status**: **ON HOLD** — split out of [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) on 2026-06-16. That task's **Fix 1** (structural tenant isolation for the *tier* DOs — Star / Galaxy / Universe) shipped as the demo-critical work. This file holds its **Fix 2**: the naming grammar for *helper* DOs. Deferred because **Fix 2's only consumer was a test fixture** (the now-removed `ResourceHistory`). Revive when a **real** tenant-scoped helper DO with a production caller lands.

## The problem, in plain language (the apartment building)

Picture Nebula as an apartment building.

- The **building** is a customer's account (`acme`) — a **Universe**.
- A **floor** is one of their apps (`acme.app`) — a **Galaxy**.
- An **apartment** is one tenant of that app (`acme.app.tenant-a`) — a **Star**.

Each room is locked. Your **key** is your login, and it has an address on it ("good for apartment `acme.app.tenant-a`"). The lock on every door is *smart*: it reads the **address engraved on the door's nameplate** and opens only for a key whose address covers it. The apartment door `acme.app.tenant-a` opens for that tenant; the shared **floor lounge** `acme.app` opens for anyone on that floor (every apartment under it). This is **Fix 1** — and it works because an apartment's name *is* its address.

Now consider a **storage locker** — a little room that holds one specific thing, e.g. "the history of resource #12345." These got named with just the thing's number, `12345`. The problem: a nameplate that reads `12345` doesn't say **which apartment owns it**. The smart lock has nothing to check your key against. Two different tenants could each have a resource `12345`; the names collide and the owner is unprovable — so the lock falls back to the broken "memorize whoever opened it first."

**Fix 2 is: put the address back on the locker's nameplate.** Rename it from `12345` to **`acme.app.tenant-a:12345`** — owner (`acme.app.tenant-a`) **and** thing (`12345`), separated by a colon. Now the same smart lock reads the part *before* the colon and checks it against your key, exactly like an apartment door. The colon is a clean seam because it's illegal inside a real address, so "split off the owner" is unambiguous, and a locker named with a missing/garbled address fails loudly.

That's the whole idea: **make a helper's owner provable from its name, by prefixing the name with the owner's scope.**

## Why deferred, not deleted

The only helper DO that ever existed was `ResourceHistory`, and it was always a *test fixture* — its own docstring said so ("no production caller; it exists only to exercise NebulaDO's tenant isolation"). It was once going to store per-resource history, but that moved to **R2** (`tasks/on-hold/nebula-resource-history-r2.md`), so `ResourceHistory` will never become a real helper. It has been **removed** as part of the Fix-1 work; the tier DOs (Star/Galaxy/Universe) now carry the isolation test coverage directly.

So building the colon-grammar now would be speculative generality for a hypothetical. The most likely *real* future consumer is **access control for the DOs that Cloudflare Think uses** (reached via the integration shim) — but whether those DOs even route through Nebula's `onBeforeCall`, or are secured at the shim boundary instead, is unspecified. The work that would answer this is `tasks/icebox/think-nebula-integration.md` (shelved — Think not adopted; its DO-containment kernel may resurface for the post-Studio in-app AI context's per-end-user agent facets). Building the grammar before we know the requirement is committing to an answer we haven't earned.

## What "Fix 2" was (the design, preserved)

When revived:
- **The wall is `onBeforeCall`, not a naming helper.** A tenant-scoped-helper call whose instance name isn't a well-formed `<scope>:<local>` (with `<scope>` covering the caller's `aud`) is rejected by the same structural check Fix 1 uses for tier DOs. `scopedName()` is *ergonomics on top* for minting correct names, not the enforcement.
- **Grammar:** separator `:` (illegal in a slug, so `parseId` rejects it). Derive scope by splitting on the **first** `:` (prefix = scope), `parseId`-validating it, requiring a non-empty slug-valid local part with no second `:`/`.`. A name with no `:` is treated as a bare tier id (scope = whole name).
- **Helpers:** `scopedName(scope, localName)` (pure form) + a thin `NebulaDO.scopedName(localName)` delegating via `this.lmz.instanceName`. Lives beside `parseId`/`buildAuthScopePattern`/`matchAccess` in **`@lumenize/nebula-auth`** — **not** `@lumenize/routing`, which already depends on nebula-auth (a `parseId`-using helper there would force a `routing → nebula-auth → routing` cycle; see the shipped task's dependency note).
- Helpers are reached **mesh-internally** (`getDOStub(env[binding], instance)` → `idFromName`, colons fine), never by a client URL — so `routeDORequest` URL parsing is orthogonal. (If a future helper *is* URL-addressed, confirm `routeDORequest` segment handling then; `:` is a legal path-segment char.)

## Key insight from the design review: you probably don't need a registry

The original Fix 2 proposed a **binding-aware registry** — a static table declaring which DO bindings require the `:` form vs a bare id. The review (workflow `wf_fcd21b25-8f5`, 2026-06-16) established that **the registry is not load-bearing for security**:

- A bare-UUID helper name `12345` derives scope `12345` → pattern `12345.*` → `matchAccess('12345.*', 'acme.app.tenant-a')` = **false → rejected** by `matchAccess` itself. No real tenant's `aud` is ever under a random UUID, so cross-tenant reach is structurally impossible regardless of any registry.
- An attacker naming `acme.app.attacker:victim-data` derives *their own* scope → resolves to *their own* junk helper, never the victim's.

So the registry bought only: (a) a prettier error ("name must be `<scope>:<local>`" vs the generic "Active-scope mismatch"), and (b) forbidding a colon-name on a *tier* binding (which without it resolves to a benign **own-scope junk DO** — already inside the accepted "benign DoS-by-naming" class).

**Recommended shape when revived — "Alternative A": grammar-only, no registry.** Derive scope purely structurally from the name (`:`-split as above); no `bindingName` parameter, no classification table, no coupling of `nebula-auth` to app-level binding names. The only accepted residual is tier DOs being colon-addressable into own-scope junk instances. This is simpler, security-equivalent, and avoids a new subsystem. The existing `NebulaAuthRegistry` (email/subject → instance-name runtime data) is **not** reusable for this — wrong layer, wrong data.

## When to revive

- A real tenant-scoped helper DO gains a **production caller** (not a fixture), **and** we know its addressing requirements.
- Most likely trigger (post-Studio): the in-app AI context's per-end-user agent facets, if they route through `onBeforeCall` — see `tasks/icebox/think-nebula-integration.md` (shelved; Think itself not adopted).
- On revival, start from **Alternative A** above unless a concrete need for clearer errors / tier-colon-rejection justifies the registry.

## Related
- [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) — the shipped **Fix 1** (structural tier-DO isolation) this builds on.
- [think-nebula-integration.md](../icebox/think-nebula-integration.md) — iceboxed (Think not adopted); its DO-containment kernel may resurface for in-app AI agent facets.
- [mesh-active-callcontext-guard.md](mesh-active-callcontext-guard.md) — closes the raw-RPC bypass around `onBeforeCall` (separate follow-on).
