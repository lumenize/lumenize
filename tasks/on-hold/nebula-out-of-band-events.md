# Out-of-band events — a generic, subscribed attention mechanism

**Status:** On-hold stub, spun out of the invite design ([archive/nebula-invite.md](../archive/nebula-invite.md) § *Transport*) on 2026-08-19. Design intent captured below; not yet through `/write-task`.

**Target shape in one line:** server-side happenings a user should learn about later (email bounce, build finished, import complete) become **Resources entities** — a discriminated-union event type, addressed to a `sub`, delivered by ordinary query-subscribe on connect/reconnect, dismissed by client soft-delete.

## What was decided when this was spun out

- **State, never push.** The flagship case (an email bounce hours after send) arrives when the addressee's tab is asleep — a mesh push has no listener. Event → durable entity write on the owning node → existing subscription broadcast → client hook. The push is just the broadcast reaching whoever is currently connected.
- **Resources is the substrate.** Query-subscribe, reconnect delivery, optimistic concurrency, history, and permissions all come free. Client deletes on processed (trust the client UI for now) — soft delete, so the live query stays bounded while snapshots keep an audit trail that the user *was told*.
- **`sub` is addressing, not secrecy.** Events are org-visible per ADR-008; the `sub` field means *whose attention*, never a read gate. Delete permission: the addressee plus admins.
- **Per-scope, not a global inbox.** An entity lives in a Star, so delivery is contextual to the scope the event belongs to. A sub adminning five Stars has five streams. A cross-scope personal inbox is a different (unbuilt, unplanned) thing — and could not live in the Registry regardless (plane-separation invariant).
- **Discriminated union, extended by adding members** (ADR-001 — the TS type is the schema). First out-of-band member: `email-delivery-failed`. Naming leans *events* over *errors* — the general form costs the same and non-error members are expected. Known member candidates: `email-delivery-failed`; "you were granted admin" (a promotee's live session gains the bit silently on refresh — decided 2026-08-19 that their notification waits for this mechanism rather than growing a bespoke path).

## The slice-2 work this stub holds

- **Webhook ingestion.** Resend reports delivery outcomes via webhook (svix-signed); the CF Email path uses a Queue — both normalize to one event shape. ⚠️ **Direction split:** nebula-auth owns verification + normalization (a pure function over the webhook request — it holds the sender, the secret, the provider knowledge); **platform** code owns the route and fires the mesh call to the Star. The email subsystem never learns what a Star is. (Registry→Resources is the forbidden direction.)
- **Correlation.** Mapping a provider's delivery event back to the invite/message it was: the `instanceName` stamp every `EmailMessage` already carries is most of the story; per-message ids/tags may complete it.
- **System-actor attribution.** A webhook-originated Resources write has no user callContext — `changedBy` needs a system-actor answer, which Resources attribution doesn't have today. (Slice 1 dodged this: its writer runs under the inviter's propagated callContext.)
- **The client hook** — the generic UI surface that renders/queues events and issues the delete-on-processed.

## What already exists when this resumes

The invite task ships `_InviteStatus` entities (`pending` → `sent` / `submission-failed`) on the same Resources substrate, org-visible via query-subscribe — the proof that the substrate carries this shape (type names beginning with `_` are the reserved platform namespace, unioned into every app ontology via `PLATFORM_RESOURCE_TYPES`). This task adds the *generic* union, the client hook, and the out-of-band sources; `email-delivery-failed` then lands as a new member feeding the same pipes.

⚠️ **Substrate decision to make when this resumes — union types on the relevant star vs a sibling per-scope comms DO.** The default is the invite precedent: another `_`-prefixed member of `PLATFORM_RESOURCE_TYPES`, riding the host's own data plane. A sibling DO (one generic channel, never one per feature) wins only when an event source hits the boundary recorded in `PLATFORM_RESOURCE_TYPES`'s JSDoc (`apps/nebula/src/ontology-compile.ts`): state decoupled from Star state, volume high enough that per-row snapshot history is a cost, or visibility other than org-visible. Webhook ingestion plausibly hits all three; start the design from that test rather than re-deriving it.
