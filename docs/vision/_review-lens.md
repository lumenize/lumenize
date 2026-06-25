# Internal review-lens checks (NOT for external / pitch use)

> **Folder convention:** files in `docs/vision/` prefixed with `_` are **internal** — they feed the
> `/review-task` product-vision lens and serve as our own strategy reference, but they are **NOT** part of
> the VC-facing pitch / leave-behind narrative (that's `strategy.md` + `enterprise.md`). The CEO / pitch
> process should **ignore `_`-prefixed files.**
>
> This file holds strategic *checks* that are correct but would be **misread out of context** by an external
> audience — e.g. anything that sounds like "we deprioritize security." They **reinforce** the public
> strategy; they don't contradict it.

## Additional strategic checks (extend the `/review-task` product-vision lens)

These extend the checks in `strategy.md`; the lens reads both.

### Security is the wedge *because it's frictionless* — flag bolted-on friction, not just weakened defaults

Secure-by-default means the security lives in the **substrate** (ReBAC/DAG, the ADR-007 core), so the
user-developer gets it **for free**. So the security check cuts **both ways** — flag a task that:

- **(a)** weakens the secure default (the footgun — already a `strategy.md` check), **OR**
- **(b)** adds security/process **friction disproportionate to the *real* (not theoretical) risk** —
  especially friction that fights a core feature (e.g. self-provisioning) or taxes dev/operator velocity.

The gates are the **standard, expected** ones (auth, email verification, Turnstile-style bot protection);
bespoke friction bolted on "to be safe" is **anti-wedge**. When a low-probability, under-the-covers-fixable
risk is in genuine tension with dev velocity or user growth, **ship** — do the best under the covers, don't
make anyone pay a friction tax for it. The non-overridable secure-by-default **substrate** stays
non-overridable; this is only about not piling friction *on top* of it.

*(Founder context: Larry authored the original DevSecOps manifesto and has long argued **Dev comes first** —
a growing user base / viable business beats addressing every security risk when they are in genuine tension.
This check encodes that, reconciled with the secure-by-default wedge: the wedge is "security with no tax,"
so adding a tax violates it.)*

### Interim-scaffold smell (also mirrored in the scope-discipline lens)

When a task adds machinery — *especially security/guard machinery* — ask whether it exists only to **defend
or elaborate a known-temporary artifact** (a placeholder/test scope, a stub, a hardcoded fixture, a
deferred-feature interim). If the design would not exist under the **real/near-term** model, the fix is to
**drop the scaffold, not harden it.** (A review panel optimizes *within* the frame it's handed; this is the
check that questions whether the frame itself is the artifact.)
