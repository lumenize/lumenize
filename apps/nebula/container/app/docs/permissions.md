# Permissions

Which sharing shape each relationship in this app got, and why. Nebula's org tree can express the same intent two ways — a **grant** on a node (limited sharing: one party owns the node, the other holds `read` or `write` on it) or a **second parent** (co-ownership: the resource sits under both, and either may act on it) — and which is right turns on whether either party may leave. A decision here is what stops the same relationship being re-proposed the other way.

Write this when: the `define-the-cast` skill decides a relationship's shape, or a request would change who may see or edit something.

## The model

Write this when: the first decision is made — one paragraph on how the tree is arranged for this app.

## Decisions

One row per relationship: the alternative rejected and why, so nobody re-litigates it.

| Relationship | Shape decided | Rejected alternative — why |
|---|---|---|
| *the organizer and a participant's wishlist (example — replace)* | a grant: participant `write` on their own list, organizer `read` | co-ownership — the organizer must never edit a wish |
