# Impersonation sessions — a client that acts as another person

**Status:** Design intent drafted 2026-07-29, pending Larry's read (`/write-task` Pass 1 — no phases yet). Unblocks nothing in pre-alpha; it exists because `/mint-narrower-token` shipped with **no consumer able to consume it**, and because the two test helpers written around that gap are already the anchoring workaround (pinned by Larry 2026-07-29: fix it now rather than backlog it).

**Objective — an admin can obtain a working `NebulaClient` that acts as another person, so that "why can't this user do X?" is answered by driving the app as them.**

## Context and current state

**Built already.**

- **The endpoint.** `/auth/{callerScope}/mint-narrower-token` (`mintNarrowerToken`, `worker-token.ts`) mints a token whose `sub` is the subject and whose `act` is the caller, under an ordered gate chain — root identity, self-narrow rejection, caller reach, admin bit, subject exists, eligibility, subject-reach mirror, in that order (the ordering is itself a disclosure decision, ADR-008). It is the only producer of a JWT `act` claim — **the qualifier is load-bearing**: the planned `prependActor` ([nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)) composes an `act` chain onto a `changedBy` **record**, never onto a signed token, so `claims.act` remains an exact signal for *this is an impersonation session*. Fully tested; see `tasks/archive/nebula-mint-narrower-token.md`.
- **The record.** `executeScopeDeletion` stamps `actingToken` — the full verified claims including the `act` chain — on scope deletion ([ADR-016](../docs/adr/016-record-the-acting-principal.md)), so a destructive action taken under impersonation already names both parties.
- **The transport.** `LumenizeClient.authedFetch` is `protected`, injects the in-memory token as `Authorization: Bearer`, refreshes when it is missing or near expiry, and retries once on a 401 — `NebulaClient`'s `scopes` namespace is built on it, keeping the JWT inside the client. ⚠️ **It has no test coverage, direct or indirect.** ✅ *Checkable:* no test file references `authedFetch`, and nothing outside `apps/nebula-studio-ui/src/App.vue` drives `client.scopes.*` — so its refresh-on-expiry, its retry branch, and its de-duplication with the WS-connect refresh are today exercised only by a human clicking through Studio. This task makes `impersonate()` its second caller and its first tested one, and the paths it leans on are exactly the untested ones.
- **The disposal seam.** `LumenizeClient[Symbol.dispose]` exists, so `using` works on a client today.

**Missing.**

1. **Any way for a `NebulaClient` to carry a token it was handed.** `NebulaClientConfig` is declared `extends Omit<LumenizeClientConfig, 'refresh' | 'gatewayBindingName'>`, and the constructor supplies `refresh` *after* spreading the caller's config — so the only token a `NebulaClient` can ever present is one minted from its own Path-scoped refresh cookie.
2. **A lifetime model for a token that cannot be refreshed from a cookie.** The minted token dies with `ACCESS_TOKEN_TTL`; nothing renews it, and the built-in refresh failure path raises `LoginRequiredError`, which `NebulaClient`'s connect path turns into `onLoginRequired`.
3. **A production path the tests can share.** Two suites hand-roll `refresh: async () => ({ access_token, sub })` over a raw `LumenizeClient` — `mint-narrower-token-payoff.test.ts` and `profile-do.test.ts`. They are the only two sites in `apps/nebula` doing this, and they exist solely because item 1 has no answer.

## Design intent, constraints, and future state

`await client.impersonate(sub, activeScope)` resolves to a **full `NebulaClient`** whose identity is that person. Full is the load-bearing word: every existing surface (`resources`, `orgTree`, `subscribe`) works on it unchanged, which is what lets a test and the Studio exercise one path.

### The parent is the credential

The returned client holds a private `#mintedFrom` handle to the client that produced it, and re-mints by calling **the same private mint helper on that handle that `impersonate()` itself calls**. One mint path, so the first mint and every re-mint cannot drift on body shape, URL, or error handling — and the child depends on the parent's *capability to mint*, never on how the parent talks to the endpoint. Five properties follow from that one fact, and they are the reason this shape was chosen over holding a fixed token:

- **No new durable credential exists anywhere.** The child's ability to act is derived entirely from the parent's in-memory session; nothing is written, cookied, or independently stealable.
- **Revocation propagates.** Every re-mint re-runs the endpoint's full gate chain, so a demoted admin, a moved subject, or a deleted subject ends the session at the next token boundary rather than at term.
- **Readiness follows the parent's *credential*, not its *connection*.** `authedFetch` obtains a token from the refresh cookie on its own path, so a parent that is disconnected, reconnecting, or not yet ready still mints. ✅ *Checkable:* `LumenizeClient` shares one in-flight refresh between the WS-connect path and `authedFetch`, and neither requires the other to have run.
- **Lifetime follows the parent *object*.** Disposing the parent disposes its children; a parent losing its socket does not. These are different events and the distinction is user-visible — a network blip must not end an impersonation session.
- **Duration is bounded by the admin's browser session**, re-authorized every `ACCESS_TOKEN_TTL`. Pinned as intended semantics by Larry, 2026-07-29.

When a re-mint terminally fails, the child surfaces a terminal disconnect of its own kind. The invariant: **the admin's own session is untouched by the end of an impersonation session**, so the failure must not travel the `LoginRequiredError` path that bounces a user to login.

### Two sessions are two clients

A second identity requires a second client object, because the subscriber tables key on the per-client id. ✅ *Checkable:* `clientId` is auto-generated per client instance at first connect; `QuerySubscribers` keys on `(queryHash, clientId)` while carrying `sub` and `profileId`, and the per-resource `Subscribers` table keys on `clientId` alone — so one connection carrying two identities writes one row with two answers to "who is here".

### The claims are the API

The child exposes nothing new. `client.claims` already answers both questions the caller has, structurally: top-level `sub` and `profileId` are the person being acted as, and the presence of `act` is what makes this an impersonation session. ✅ *Checkable:* `NebulaClient` re-declares `claims` as non-null on the strength of the factory's `ready` resolving after the first refresh — a client from `impersonate()` must preserve that guarantee, since every blessed example writes `client.claims.sub` unguarded.

### Authorization stays on the server

This task changes no authorization. The endpoint's gate chain remains the enforcement, and the client adds no check that could disagree with them. The single client-side refusal — that impersonation does not chain — is decidable from the client's own claims, is enforced independently by the endpoint's root-identity gate, and exists to convert a structurally impossible call into an accurate message instead of a 403 that reads as a problem with the subject.

⚠️ **`security.md` delegation rule (1) binds here**: the client reads `act` for presence only, never to decide an authorization outcome, and the licensed exception list stays at one member (the Profile owner branch).

### Retiring the workaround is the point

The two hand-rolled helpers are not incidental cleanup — they are the reason this task is being built now rather than backlogged. They are currently the only worked example in the repo of "drive a DO as an impersonated user", so the next person needing that copies them, and the shape ossifies. Moving both onto `impersonate()` while there are exactly two of them is the whole argument for the timing.

The gain is fidelity, not tidiness: those helpers construct a raw `LumenizeClient`, so they exercise a path the Studio can never take, and any defect specific to a `NebulaClient` carrying a narrower token is invisible to them.

### Constraints

- [ADR-009](../docs/adr/009-real-auth-path.md) — the adopted tests stay rung 1; the token under test comes from the real endpoint via a real admin's real session.
- [ADR-016](../docs/adr/016-record-the-acting-principal.md) — already satisfied by the endpoint and the registry record; this task adds no new destructive action.
- `.claude/rules/security.md` delegation rules (1) and (2) — both hold unchanged (above).
- `.claude/rules/mesh.md` — the child is an ordinary client; `impersonate` is an HTTP call over `authedFetch`, matching how `scopes` reaches nebula-auth.
- CLAUDE.md § package feedback — the `Omit` that closed a footgun also closed the capability; the resolution keeps the `Omit` and adds a factory, so callers never supply a token and scope that can disagree.

### Future state

This is the client capability the admin-debug UI needs; the UI itself is out of scope. It also makes an impersonated session available to any future test that needs to observe the app as a specific person.

⚠️ **Design consideration:** [ADR-017](../docs/adr/017-the-url-is-the-view-state.md) is the other half of the support flow — an admin needs the subject's `activeScope`, and Studio's URL does not yet carry it (`backlog.md` § Nebula Studio UI). Neither task gates the other.

⚠️ **Design consideration:** a hard cap on impersonation duration is deliberately absent. Should one ever be wanted, the re-mint is the single place it would live.

⚠️ **Design consideration:** `#mintedFrom` / `#minted` are private with no public accessor, which keeps the option of changing the parent-child representation later without a public break.

⚠️ **Design consideration:** two things here rest on `claims.act` being an exact signal for an impersonation session — the refusal to chain, and the self-awareness story that adds no new API. Keeping `prependActor` on the record side preserves that. Were an `act` chain ever composed onto a **token**, this file's chain refusal would reject a legitimate call from a person whose own session carried a prepended platform actor, and the Profile owner branch would deny them their own profile (already noted at `profile.ts`). That is a reason to keep the prepend on records, not a constraint this task enforces.

### Open questions

None. Every decision this file depends on was settled in conversation on 2026-07-29 — the API shape and its name, both parameters explicit and required, expiry via re-mint, the dispose-vs-disconnect distinction, exposing nothing beyond `claims`, refusing to chain, and allowing codegen from an impersonated session.
