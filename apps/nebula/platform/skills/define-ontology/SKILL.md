---
name: define-ontology
description: The app's data model, when a request names data the ontology does not yet hold or a change needs a field or type it lacks. Read this BEFORE any view skill — it decides, from the prompt, whether to propose a shape and build or to ask first.
---

# Define the ontology

The ontology (`src/ontology.d.ts`) is the app's data model, as TypeScript interfaces. Every resource a component reads or writes has a type here first. This skill is a judgment about how much to ask, then one file write.

## Ask, or propose and invite correction

Whether to ask before writing the shape is your call, made from what you know. Three things tell you, in the order they exist:

- **How much shape the prompt already carries.** "Create a wishlist app" carries none: propose a reasonable shape, build it, and state the shape in your reply so a correction is one sentence away. A prompt that names fields, relationships or rules carries hints: ask the one or two questions those hints leave open, then propose. The number of questions scales with the hints — never a questionnaire.
- **The user-developer's stated preference** for being asked or being shown, once their profile carries it. Today it does not; do not invent one — the prompt is the signal.
- **The conversation so far.** A correction to a shape you proposed is a signal to ask more the next time; a "just build it" is a signal to ask less.

## Before you start

Read `.platform/docs/ontology.md` — in particular *References between types*: a field typed as another resource type is a reference held by id, never an embedded object, and related resources are created as separate ops in one transaction. Read the current `src/ontology.d.ts` with `read_file` so you extend what exists rather than replace it.

## Procedure

1. **Name the things.** From the request, list the kinds of thing the app stores — a `Wishlist`, a `WishlistItem`, a `Group`. One interface per kind. Prefer the user-developer's own words for the names.
2. **Decide what each one holds.** For each kind, what does a `WishlistItem` need — a name, a link, a price, who claimed it? Take what the request answered; where the prompt's hints leave a real choice open, ask, one question at a time. Stop when the shape is enough for the request at hand; the ontology grows later.
3. **Decide each relationship.** For every field that points at another kind, state it as a reference (`list: Wishlist` — an id on the wire) and say which side owns the list of ids (a container holding `items: string[]` is how a list renders). Ask only when two shapes are both plausible.
4. **Propose the shape.** With `@title` on each interface and `?` on every field that may be absent. When the prompt carried no hints, write it and state the interfaces in your reply so a correction is one sentence away. When it carried hints, or the user-developer prefers to be asked, show the interfaces in prose and wait — their yes is the write's trigger.
5. **Write the file.** `write_file` the complete `src/ontology.d.ts` (it is a deliberate rewrite of one file, so `write_file`, not `edit_file`), then `build` — the ontology step of the report compiles it and reports errors by line. Fix and build again until the ontology step is clean.
6. **Say what changed and what comes next.** One sentence naming the types added or changed. Applying the ontology to the running app is the user-developer's step outside this chat; say that it is ready to apply. If the change removes or retypes a field that existing data uses, say that applying it will need a data wipe, so they decide with eyes open.

## What not to do

- Do not invent fields the request did not ask for "in case". A missing field is one more turn; a wrong one is data to migrate.
- Do not use `T | null` where `field?: T` says the same thing.
- Do not embed one resource's value inside another. If you want to, it is a reference.
