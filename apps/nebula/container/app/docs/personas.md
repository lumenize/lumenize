# Personas

The cast: each kind of person who uses this app, and the steps in plain words that rebuild their grants and sample data. The `define-the-cast` skill says how to write this file and how to build from it.

Write this when: the `define-the-cast` skill has settled the cast, or a new kind of user appears in the conversation.

## The cast

Write this when: the personas are named. One list line for each, which Studio reads for its tabs: the slug in backticks, then the full name and what they do, as in "`ollie` — Ollie Organizer. Runs the exchange and sees every list."

## Building the cast

Write this when: the cast is settled. Numbered steps in plain words that rebuild the cast's grants from nothing, each one of: create a **node**, add an **edge** beneath another node, **invite** a persona onto a node at a tier. A worked example for a secret-santa app, to replace with this app's own:

1. Create the node `lists` under the root.
2. Create the node `example` under `lists`.
3. Invite `ollie` onto `lists` with `admin`.
4. Invite `pat` onto `example` with `write`.

## Sample data

Write this when: the app has something to show. Numbered steps in plain words, each naming the persona whose tab makes the record, as in "As `pat`, add three wishes to `example`."
