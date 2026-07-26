# The identity data model — behaviour and access-control decisions, before the schema

**Status:** Decisions document, open. **No schema is pinned here yet** — that is deliberate. The questions in § Decide now each get encoded *structurally* by whatever schema we write, so answering them afterwards means reverse-engineering them out of the tables later. That is how `Identities` came to carry five jobs.

⏳ **Timing — this rides the pre-alpha wipe's schema-surgery window** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *The wipe is a CLOSING WINDOW for free schema surgery*): greenfield now, migration-bound forever after. It is **item 5** on that queue and the largest of them.

📥 **Absorbed:** the `profileId`-join half of [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) (its former §3). That task keeps the per-invitee admin mint; the join lives here, because *where* it happens follows from § Decide now D1–D2 rather than preceding them.

## Why the current model needs a decision, not a patch

`profileId` is a repeated column value on `Identities`, found through a non-unique index. Nothing's identity is "this human." So **"one human" is an emergent property of N rows agreeing on a value**, and three things follow that all read as separate bugs but are one cause:

- **Canonical-ness has to be derived** (`ORDER BY createdAt LIMIT 1`) rather than looked up — so the person's identity depends on row order, and a row can compete with itself for canonical status.
- **An attacker can inject a competitor.** Two mint paths are open and unauthenticated (Turnstile-only), so a row bearing anyone's email can exist before that person acts. Filtering on `emailVerified` narrows the race; it does not remove it.
- **`email` has N uncoordinated copies.** `changeEmail` updates one row of N ([backlog.md](backlog.md) § Nebula Auth). Its JSDoc premise — *"nothing keys off email"* — was true when written and is false now, since `UNIQUE (email, universeGalaxyStarId)` *is* the `discover` lookup.

A per-human entity turns all three from derived properties into stored ones. Whether that is the right answer depends on D1–D2 below.

## How to read this file

Every proposition is tagged. **Settled** = already committed in an ADR or a shipped decision; listed so the schema honours it, not to reopen. **Decide now** = the schema cannot be written without an answer. **Deferred** = keep the seam open, build nothing.

---

## Settled — the schema must honour these

| | Proposition | Where it is committed |
|---|---|---|
| **S1** | **A profile is display-only. It is never an input to authorization over anything else — a profile authorizes only *itself*.** ⚠️ The carve-out is load-bearing: `profileId` *is* an authz input for writing **that** profile (`#requireOwnerOrAdmin`'s owner branch is `claims.profileId === profileId`, zero reads). "Not in the hierarchy" ≠ "never an authz input at all", and the difference is exactly where D7's leak lives. | [ADR-012](../docs/adr/012-global-profile-visibility.md) as amended 2026-07-26 |
| **S2** | **Scopes are the coarse-grained access-control entity.** Authority flows strictly downward and only downward; the bare `admin` bit is never authority by itself. **Fine-grained access control is the orgTree DAG in the data plane — out of scope for this file.** | [ADR-015](../docs/adr/015-scope-authority-flows-downward.md) |
| **S3** | **Email is never a primary key.** It is a mutable natural attribute. Keys are random opaque values, generatable without coordination — never a natural/mutable attribute, never a counter. | [ADR-010](../docs/adr/010-random-opaque-keys.md) |
| **S4** | **The registry singleton owns scope existence and email ownership.** Scope existence is independent of membership (a wildcard-managed child scope has a `Scopes` row and zero members). | [archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md) |
| **S5** | **Proving control of an email *authenticates*; memberships *authorize*.** Email is the channel, never the authorization key. *(This is the precise form of "email determines access" — the loose form invites putting email back on a durable path, which is what caused two prod wipes.)* | [ADR-010](../docs/adr/010-random-opaque-keys.md), surrogate-sub |
| **S6** | **`sub` stays the membership key and the resource FK.** Resources/grants/snapshots key on `sub` only; `profileId` rides as a display copy. ⚠️ If `sub` ever became per-*person*, every snapshot re-keys — ADR-013 exists to prevent that, so the split must leave `sub` where it is. | [ADR-013](../docs/adr/013-identity-profileid-resolution.md) |
| **S7** | **An `Emails` table is not a return to the wipe-causing shape.** The old defect was `Emails.email` (registry DO) ↔ `Subjects.email` (per-scope DO) — a *natural key doing cross-DO FK duty*, unenforceable, with no safe change flow. A table inside the **one** registry DO, with a surrogate PK and email as a `UNIQUE` *attribute* whose FK is a random opaque `profileId`, has none of those properties. State this or it gets re-litigated. | surrogate-sub § The problem (1) |

---

## Decide now — the schema cannot be written without these

### D1 · Is a membership keyed on the **person** or on the **email**? ⬅️ everything else falls out of this
Today: the email. `sub` is minted **one per `(email, scope)`**. Carry that forward together with multi-email (D8) and one human with two addresses in one scope gets **two `sub`s** — two attributions, rendering as two people in a chat thread.

Per-person instead: `UNIQUE (email, scope)` disappears, login becomes `email → profileId → membership(profileId, scope)`, and `sub` means "this person's membership here."

**Lean: per-person.** It is the only reading under which multi-email doesn't re-fragment the human we just spent effort unifying. Cost to name: login gains one lookup (two sync SQL reads on a singleton DO instead of one — cheap, but it *is* the reason the old `Emails`+`Subjects` merge happened, so say it out loud rather than rediscovering it).

### D2 · Does a Profile exist before any email is verified?
Equivalently: **can a membership exist with no Profile?** What does an unverified invite or open claim create — a placeholder Profile, or only a pending email?

**Lean: no Profile until first verification.** If an unaccepted invite or an anonymous `claim-star` creates no Profile, then the first-mover/capture class **stops existing** rather than being filtered against — no `ORDER BY createdAt` race, no row competing with itself, and the `AND emailVerified = 1` predicate becomes unnecessary rather than load-bearing. This is the single decision that most simplifies what identity-mint's §3 was struggling with.

### D3 · Can any verified email on a Profile authenticate into any of that person's memberships — or only the address that was invited?
Austen is invited at `austen@work` and later attaches `austen@home`. Can she log into that scope with `austen@home`? Product question with a security edge: "any verified email" widens each membership's authentication surface to every address the person has ever proven.

### D4 · Which address receives the magic link for a given scope — any, or a designated primary?
Interacts with D3. Also decides whether `MagicLinks`/`InviteTokens` keep storing a bare `email` or move to an email/person reference.

### D5 · When the last membership for a Profile goes away, does the Profile survive?
Today the Profile DO is simply orphaned on scope deletion ([backlog.md](backlog.md) § Profile store follow-ons). With a per-human entity this becomes answerable rather than accidental: reap, or keep for a returning person?

### D6 · Within a scope, what may a member see of another member's email? (ADR-008 interaction)
ADR-008 makes member identity visible within a Star, and `#otherUsers` discloses emails today for the deletion warning. Under multi-email: which address — the one they joined with, all of them, or none? "All of them" leaks addresses across scopes the viewer has no relationship to.

### D7 · Is "act as this person" a capability bounded by scope?
The `/delegated-token` finding as a **model rule** rather than a patch: that endpoint bounds `activeScope` to the caller's reach but places no bound on `actFor`, and stamps the target's `profileId` into the minted token — which S1's carve-out makes a write capability over that person's profile. Bug filed at [backlog.md](backlog.md) § Nebula Auth; **the model rule belongs here**, because "who may act as whom" is a property of the identity model, not of one endpoint.

### D8 · Do we model multiple emails per Profile **now**?
Larry, 2026-07-26: yes in principle. Worth deciding explicitly that we model it in the schema now while it is free, **even though the flow that attaches a second email stays deferred** (F1). Storage is nearly free; the hard part was always *proving control of both*, which is a flow problem, not a modelling one. Modelling it now costs a table we are already opening; retrofitting it later costs a migration.

### D9 · Does identity-mint's §5 come here too?
§5 (drop the Profile's scoped-admin branch) is a **model-conformance fix** — make the code match S1 — and it is in `profile.ts`, not on the invite path. With the join absorbed here, §5 is arguably orphaned in identity-mint, and it is the same family as D7. Left in identity-mint for now; **not moved unilaterally.**

---

## Deferred — keep the seam, build nothing

| | Deferred | Home |
|---|---|---|
| **F1** | The flow that **attaches a second email** to a Profile (proving control of both). The rails are settled and hard-won: a breadcrumb cookie is advisory only and never an input to the decision; a confirm modal is not proof; never link silently. D8 makes the *schema* admit N emails; this is how one gets added. | [on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md) |
| **F2** | **Merging two Profiles** that turn out to be one human. Correct SQL form already recorded (re-point every `sub` in the losing set, then converge each one's KV record with its own original absolute expiry). | same |
| **F3** | Replacing the `isAdmin` boolean with a per-person **grant set**. The schema should not foreclose it; it should not build it. | [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) |
| **F4** | An **audit trail for who minted an admin**. Nothing persists the actor today (no column on `Identities`; only a DEBUG-gated log). Post-wedge per `enterprise.md`'s timing gates. | [backlog.md](backlog.md) § Nebula Auth |

---

## What follows once D1–D2 are answered

Sketch only, to show the shape the answers imply — **not pinned, and deliberately not drawn as a diagram yet.** A diagram of an undecided model is exactly the artifact people anchor on; once D1 and D2 are settled it is worth one.

Under the leans above (per-person membership, no Profile before verification):

- **A per-human entity** whose PK is the `profileId` — turning it from a repeated column into a real FK target, and giving canonical-ness somewhere to be *stored*.
- **`Emails`** — surrogate PK, `email UNIQUE`, FK to the person, plus per-email verification state. Email lives **once**, so `changeEmail` becomes a one-row update that is actually correct.
- **`Memberships`** — the renamed `Identities`: `sub` PK (S6, unchanged), FK to the person, FK to the scope, `isAdmin`, `createdAt`. This is what `Identities` already *is* — a join table — which is why the name has stopped describing it.
- **`Scopes`** unchanged. Deliberately: hierarchy-in-the-string works, the `LIKE 'prefix.%'` descendant scan is fine at this scale, and ADR-006 already defers FK integrity. **No `parentId`, no `tier`, no `founderSub`** — the last was explicitly rejected 2026-07-21 (at signup there is no authenticated principal, so an eager founder stamp needs a backdoor).

Also worth folding in if we are opening the schema anyway: `MagicLinks` and `InviteTokens` are byte-identical four-column tables, and [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) wants **one** `Contexts(tokenHash → payload)` keyed against "the flow's already-minted token" — awkward with two token tables to key against. Low priority; mention it in the same breath, don't let it drive.

Add `CHECK (col IN (0,1))` to every boolean-ish column while creating them — SQLite has no `ALTER TABLE ADD CONSTRAINT`, so it is cheap only now (already queued as wipe item 4).

## Relationships

- **Absorbs** the `profileId`-join half of [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) (its former §3). That file keeps the per-invitee admin mint and, for now, §5 (see D9).
- **Rides** the pre-alpha wipe's schema-surgery window ([nebula-pre-alpha.md](nebula-pre-alpha.md)) as item 5 — the largest queued item. Everything here is free now and migration-bound afterwards.
- **Fixes, structurally, two filed bugs:** `changeEmail`'s one-row-of-N update, and the emergent-canonical-ness that makes first-mover capture possible (both [backlog.md](backlog.md) § Nebula Auth).
- **Does NOT fix** the `/delegated-token` leak — that is `profileId`-as-bearer-capability, independent of where it is stored. D7 decides the rule; the bug has its own row.
- **Constrained by** ADR-010 / ADR-012 / ADR-013 / ADR-015 (§ Settled). If an answer here needs one of them changed, that is an ADR amendment, stated as such.
- **Unblocks nothing on the critical path directly** — the Galaxy collapse does not wait on it. But identity-mint's §3 does, which is why the join moved here.
