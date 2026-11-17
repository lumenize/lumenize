---
name: define-the-cast
description: Elicit the app's personas and decide each relationship's sharing shape, write docs/personas.md and docs/permissions.md, then build the cast and its sample data from the preview's tabs with run_in_tab. Use when a request names more than one kind of user, when people share, invite or hold read-only or write access to each other's data, when who may see or change something is unclear, when the cast or its data needs building again, or when asked to wipe, reset or clear the test data, which ends with the cast built again.
---

# Define the cast, decide how they share, and build them

An app with more than one kind of user has a permission model, and Nebula's org tree can express the same intent two ways: a grant on a node (limited sharing) or a second parent (co-ownership). Which is right turns on whether either party may leave. This skill elicits the cast, decides each relationship once, records both, and then makes the cast real: each persona becomes a test member of the workspace, with a tab of their own in the preview.

## Before you start

Read `.platform/docs/access-control.md` — *Worked example: sharing in a todo-list app* and its *When to use which* — for the two shapes and the test that separates them. Read `docs/personas.md` and `docs/permissions.md` with `read_file`; both are seeded with headings and a template, and you write into them rather than replacing them.

## Procedure

1. **Name the personas.** From the request and `docs/vision.md`, list each kind of person who uses the app — the organizer, a participant, an admin. Give each an **alliterative name whose first name starts with the same letter as their role**: Manny Manager, Devon Developer, Ollie Organizer, Pat Participant. The name says what they do, so a strip of eight tabs reads at a glance and nobody has to hold a mapping. Add one line on what each one does, and ask the user-developer to confirm or correct the list.
   - **The slug is the first name alone, lowercase, three characters or more** — `manny`, `devon`, `ollie`, `pat`. It is the tab's label and part of the persona's web address, so keep it short. A two-letter slug is refused: pick `eddie` rather than `ed`. The full name is a display attribute you may edit freely afterwards.
2. **Find the relationships.** For every pair of personas that touch the same data, name the data: the organizer and a participant's wishlist; two co-organizers and the event.
3. **Ask, per relationship: co-owner or limited share?** Put the question in their terms: "Can the organizer edit a participant's wishes, or only see them?" A limited share is a grant — one party owns the node, the other holds `read` or `write` on it. Co-ownership is a second parent — the resource sits under both, and either may act on it. One question per relationship, in order.
4. **Record each decision.** In `docs/permissions.md`, one row per relationship in the Decisions table: the relationship, the shape chosen, the alternative rejected and why. For example: *the organizer and a participant's wishlist — a grant, participant `write` on their own list and organizer `read`; co-ownership rejected, because the organizer must never edit a wish.* Add the prose that explains the model above the table.
5. **Write the cast and its steps.** In `docs/personas.md`, with `edit_file`. A data wipe keeps the cast's memberships and drops their grants and data, and these steps are what give both back:
   - Under *The cast*, one list line for each persona, opening with its slug in backticks: `` - `ollie` — Ollie Organizer. Runs the exchange and sees every list. `` Studio shows a tab for each such line.
   - Under *Building the cast*, numbered steps in plain words: the nodes to create, and which persona is invited onto which node at which tier.
   - A limited share is a grant on a node, so each thing shared on its own needs its own node: one per list, not one per person holding every list. Say so in the steps, as "create a node for the list under `user-sally`".
   - Under *Sample data*, numbered steps in plain words, each naming the persona whose tab makes the record.
6. **Build the cast and its data,** as the next section says, following the steps you wrote.
7. **When a later request changes the cast or its steps, apply the change in the same turn.** Invite the new persona, add the grant or make the record from the tabs as you edit the file. Do not leave it for a wipe.

## Build the cast and its data from the tabs

The preview has a tab for the person you are working for, `me`, and a tab for each persona *The cast* names. `run_in_tab` runs code in one of them, with the app's own `client` and `store` in scope, as that tab's member. The tabs are pages of the built app. An app that has been built and previewed before is ready; one that never has needs that first.

1. **From `me`, create the nodes and invite each persona.** One run can do all of it:

   ```js
   // run_in_tab tab: "me"
   const ROOT = '00000000-0000-4000-8000-000000000000'; // every workspace's root node
   const lists = crypto.randomUUID();
   await client.orgTree.createNode(lists, ROOT, 'lists', 'Lists');
   const pats = crypto.randomUUID();
   await client.orgTree.createNode(pats, lists, 'pat', "Pat's lists");
   // One invite for each node, naming only the people that node is for.
   const all = await client.resources.invite(lists, [{ email: await client.personaAddress('ollie'), tier: 'admin' }]);
   const own = await client.resources.invite(pats, [{ email: await client.personaAddress('pat'), tier: 'admin' }]);
   return { lists, pats, all, own };
   ```

   A grant reaches everything beneath its node. So a persona invited onto a node that holds other people's nodes can do the same to all of theirs: where each person has a space of their own, invite each onto their own node, never onto the parent they share. An invite makes the persona a member of the workspace and grants the tier on that node. Inviting a persona who is already a member onto another node adds that grant. To find a node made in an earlier run, read the tree: `[...store.lmz.orgTree.value.nodes].find(([, node]) => node.slug === 'lists')[0]`.
   - **A persona who administers the whole workspace**, as the app's owner does, is invited into the workspace itself with the admin bit: `await client.invite(client.claims.aud, [{ email: await client.personaAddress('manny'), scopeAdmin: true }])`.
2. **From each persona's own tab, set their name.** `await client.patchMyProfile({ name: 'Ollie Organizer' }); return client.claims.sub;`, run with tab `ollie`. The patch changes only the field it names, so the nickname the invite gave them, their slug, stays. If the run says the persona is not a member yet, run it again.
3. **Make each record from the tab of the persona who would have made it.** The record then names that persona, so what the others see of it is what the app's real users would see. A node is named by its id, never its slug, so find it in the tree first, and return the transaction's outcome:

   ```js
   // run_in_tab tab: "pat"
   const node = [...store.lmz.orgTree.value.nodes].find(([, n]) => n.slug === 'example')[0];
   const outcome = await client.resources.transaction({
     [crypto.randomUUID()]: { op: 'create', typeName: 'Wish', nodeId: node, value: { text: 'A kettle' } },
   });
   return outcome.kind; // 'committed'
   ```

   - **Keep each run small, and return what it made.** A run is not one transaction: when its fifth line fails, the first four have already happened. So make the nodes in one run, the records in the next and the shares in a third, and return the ids each made so the next run names them.
   - **Never retype an id.** A UUID copied by hand from an earlier result goes wrong by one character. Find the node or record again in the run that needs it, by slug or by a field's value, as the example above does.
   - **Several runs go in one step.** Setting each persona's name is one `run_in_tab` call per tab, and they can all be asked for together.
   - **After a run fails, look before running it again.** Return what the tab holds, `Object.keys(store.resources.Wish ?? {})` and the tree's slugs, and make only what is missing. A stray record is removed with `{ op: 'delete', typeName }` at its id. Wipe only when asked to: a wipe drops every grant too, and the whole cast has to be built again.

4. **Look through another persona's tab.** Read what `ollie` sees and compare it with the decisions in `docs/permissions.md`. A persona who sees what they should not, or cannot see what they should, is a grant to fix:

   ```js
   // run_in_tab tab: "ollie"
   const q = client.resources.subscribeQuery({ typeName: 'Wish', filter: {}, allowScan: true });
   await q.ready;
   const wishes = [];
   for (const id of q.resourceIds) wishes.push((await client.resources.read('Wish', id)).value);
   q[Symbol.dispose]();
   return wishes;
   ```

The tool's own description says what a run returns and how to read it. `.platform/docs/api-reference.md` has every call the code may make.

## Wipe the test data, then build the cast again

Studio has no wipe button: a person who wants the workspace's test data gone asks you. **A wipe is not finished until the cast is built again.** It leaves every persona a member who holds nothing, so each persona's tab opens on an app that refuses them. A request to wipe, reset or clear the test data is therefore a request for both steps below, in one turn, even when it names only the wipe.

1. **Wipe from `me`.** Run `await client.resources.resetDevData(); return 'wiped';` with tab `me`. It erases every record, node and grant in the workspace, and keeps the cast's memberships. The app's owner and every collaborator administer the workspace and may wipe it. If the run is refused, say why and stop.
2. **Build the cast and its data again, before you answer,** by the steps in `docs/personas.md`, as the section above says: the nodes and invites from `me`, then each persona's name and sample data from that persona's tab. Skip this only when the person said to leave the workspace empty, or the file names no cast.
3. **Say what you did:** that the test data was wiped, and what you built again.

## What not to do

- Do not choose a shape by default. A grant where an edge was decided, or the reverse, is the mistake the Decisions table exists to stop; if a later request would re-propose one, read the row first.
- Do not invent a persona the app does not need. Two is a cast.
- Do not write an email address, here or in code. `client.personaAddress('pat')` spells it from the page's own address, and one you compose is a different person: one address is one profile across the whole platform.
- Do not write a `sub` or any other id into `docs/personas.md`. A wipe drops every node, and the steps must rebuild them by slug.
- Do not make a persona's data from `me`. The record would name the person you are working for.
