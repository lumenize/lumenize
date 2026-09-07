---
name: define-the-cast
description: Elicit the app's personas and decide each relationship's sharing shape, then write docs/personas.md and docs/permissions.md. Use when a request names more than one kind of user, or when who may see or change something is unclear.
---

# Define the cast, and decide how they share

An app with more than one kind of user has a permission model, and Nebula's org tree can express the same intent two ways: a grant on a node (limited sharing) or a second parent (co-ownership). Which is right turns on whether either party may leave. This skill elicits the cast, decides each relationship once, and records both.

## Before you start

Read `.platform/docs/access-control.md` — *Worked example: sharing in a todo-list app* and its *When to use which* — for the two shapes and the test that separates them. Read `docs/personas.md` and `docs/permissions.md` with `read_file`; both are seeded with headings and a template, and you write into them rather than replacing them.

## Procedure

1. **Name the personas.** From the request and `docs/vision.md`, list each kind of person who uses the app — the organizer, a participant, an admin. Give each a name (Sally the organizer, Gerry a participant) and one line on what they do. Ask the user-developer to confirm or correct the list.
2. **Find the relationships.** For every pair of personas that touch the same data, name the data: the organizer and a participant's wishlist; two co-organizers and the event.
3. **Ask, per relationship: co-owner or limited share?** Put the question in their terms: "Can the organizer edit a participant's wishes, or only see them?" A limited share is a grant — one party owns the node, the other holds `read` or `write` on it. Co-ownership is a second parent — the resource sits under both, and either may act on it. One question per relationship, in order.
4. **Record each decision.** In `docs/permissions.md`, one row per relationship in the Decisions table: the relationship, the shape chosen, the alternative rejected and why. For example: *the organizer and a participant's wishlist — a grant, participant `write` on their own list and organizer `read`; co-ownership rejected, because the organizer must never edit a wish.* Add the prose that explains the model above the table.
5. **Write the cast as a procedure.** In `docs/personas.md`, fill the numbered steps using the four verbs the template names — mint, node, edge, grant — so the same cast can be re-created after a data wipe: *Step 1: mint Sally as the stand-in founder. Step 2: create the node `lists`. Step 3: add `example` beneath it. Step 4: grant Gerry `admin` on `example`.* Keep personas keyed by name, never by id; every persona's address is on a reserved dead domain such as `@example.com`.
6. **Stop and hand it over.** Creating the personas' identities and applying the grants is a confirmed step outside this chat, run from the file you wrote; say that the cast is ready to provision. Use `edit_file` for both files — they hold headings and a template you keep.

## What not to do

- Do not choose a shape by default. A grant where an edge was decided, or the reverse, is the mistake the Decisions table exists to stop; if a later request would re-propose one, read the row first.
- Do not invent a persona the app does not need. Two is a cast.
- Do not write a `sub` or any id into `docs/personas.md`; ids are re-minted by every wipe.
