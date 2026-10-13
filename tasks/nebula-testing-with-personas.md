# Personas

**Status:** Pass 1, rewritten on 2026-10-09 and reshaped at two gates on 2026-10-10; Larry hand-reviewed § *Context*, § *Objective and goals* and § *Design intent*. Waiting on its two sibling tasks (§ *Relationships*); then the author applies the third pass's remaining findings, Pass 2 writes the phases, and Stage 2 runs.

## Context

One of Lumenize Nebula's main selling points is that every app built automatically gets a robust fine-grained access control model using our DAG orgTree model for Resources.

Right now, the preview in Nebula Studio is a single iframe. The user-dev is expected to log in as founder, invite other users with their own dummy email addresses, accept those invites, and then log out as founder and in as each of those other users one at a time to test their fine-grained access control and see how the UI changes based upon those permissions. That does not align with Lumenize's de✨light✨ful DX core value.

Further, we want to guide each user-developer to good software development practices and one of those practices includes utilizing a cast of named personas to think about the experience of their users. We already have some support in the platform standing guidance for encouraging this but we have more planned including testing. That guidance is `apps/nebula/platform/`: `AGENTS.md` names the cast file, and `apps/nebula/platform/skills/define-the-cast/SKILL.md` is the skill that elicits it. The files the model writes into the user-developer's Workspace repo are `docs/personas.md` and `docs/permissions.md`; the skill itself is ours and ships in the bundle.

This task is the next increment on that fine-grained permissioning journey and we've chosen to tie the permissioning model to a cast of personas, not a list of "roles", partially to highlight the difference between our ReBAC, not RBAC, model. That case is made in [auth.md](../docs/vision/auth.md) § *The layers a call passes* — the M7 data-plane DAG bullet, and the *Why relationships rather than roles?* paragraph beneath it, which cites AuthZed on role explosion.

**The examples follow one app.** Jennifer, a real pre-alpha user, is an admin of the Universe `acme`. By a Galaxy admin this file means anyone with dominion over the Galaxy, which includes every admin of its Universe, so Jennifer is a Galaxy admin of the app `crm`. Austen, also real, builds `crm` with Jennifer as a collaborator and holds no admin bit at the Galaxy. The app's cast has three personas: Mary, the account's admin, and Sally and Gerry, two of her team. Mary's page is at `mary--dev.crm.acme.lumenize.dev`.

The rest of this file covers what exists today, the design, its decisions, and what a build must show.

## Objective and goals

**Objective -- create a de✨light✨ful experience for testing a Studio authored app as each persona.**

**Goals:**

1. **Provision each persona as a user.** On request, once the person who asked confirms, wipe the dev Star and build each persona's nodes, edges and grants from `docs/personas.md`, and the cast record the Galaxy keeps: each persona's slug, name and admin mark. Nothing is provisioned in the Registry.
2. **Seed just enough test data to show off the difference in each persona's permissions.** Every run seeds the freshly wiped dev Star. In scope, as the build's last phase, so the tabs can ship first if it drags.
3. **Log each persona in to a separate tab in the preview area.** The preview area gets a set of tabs with the persona slug as the tab label (in addition to a "Me" tab as the user-dev that will be present even before personas are defined).
4. **Every collaborator in a Galaxy can test as the cast.** A Galaxy has exactly two kinds of collaborator. A Universe and/or Galaxy admin, such as Jennifer, can do everything, including invites, the Galaxy's settings and its tenant Stars. An Austen can chat, provision the personas, open their tabs and the Me tab, and wipe the dev data, but cannot invite anyone into the Galaxy, change the Galaxy's settings, or most importantly, reach its tenant Stars. In the dev Star she can do whatever she wants. We trust her with helping build the app but not the app's tenants' data.

## Relationships

- **Two tasks still gate it: the one of its two 2026-10-10 siblings still to build, and [nebula-build-reaches-every-studio.md](nebula-build-reaches-every-studio.md), which tells every Studio on the app which build landed, the value the strip reloads its frames by.** The dev Star running the last build's ontology was built and archived on 2026-10-12, [nebula-star-ontology.md](archive/nebula-star-ontology.md), so the hand-off has the last build's compiled row to carry. The agent's voice in chat comes next: it posts as itself, and it answers posts that arrive during a turn. Personas then builds on both. The Gateway task and the build box's policy move, which it also follows, were built by 2026-10-09.
- **It rides the deploy, not the data.** Nothing here changes a stored shape a later migration would have to carry, so it gates ⑥, the wipe and redeploy, only by needing to be in the bundle.
- **It owns the cast guidance.** ① ([archive/nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md)) shipped `docs/personas.md`, the `define-the-cast` skill and a seed template, and is frozen, so every edit those files still owe is a phase here.
- **It shares the subject, grant and scope core with [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md).** That is the pull half, someone climbing the tree to ask an admin for access; this is the push half, a cast provisioned up front. Share the core, do not fork it.
- **It builds no inbound path, so [nebula-outside-world.md](nebula-outside-world.md) is neither a home nor a blocker.** A persona has no address, so no mail reaches the platform on its behalf.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Denied access in generated apps*** owns the guidance that teaches a generated app to show a persona what it is denied. This task asserts only the data plane's half: a denied persona's subscription answers with `deniedNodes`.
- **[nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 13: A person with no name is asked for one*** holds whether a generated app asks anyone for a name. A persona never needs it, because provisioning writes the name.
- **ADR changes.** [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md) § *A persona's host* was amended for this task on 2026-10-09. [ADR-015](../docs/adr/015-passage-and-dominion.md)'s rule for a chain a node started, and [auth.md](../docs/vision/auth.md)'s § *`activeScope`*, § *How the claims travel*, § *Identity and membership* and § *Grants*, were amended for it on 2026-10-10.

## Current state

**Built already, and what becomes of each part:**

- **A persona's id.** `personaId(star, slug)` in `packages/mesh/src/auth/hosts.ts` hashes `acme.crm.dev/mary` under a fixed namespace into a version-5 UUID, while a person's ids from `crypto.randomUUID()` are version 4. *Carried unchanged.*
- **A persona's host.** `parseHost` in `hosts.ts` parses `mary--dev.crm.acme.lumenize.dev`, refusing a slug that fails `isValidSlug` or is shorter than `MIN_PERSONA_SLUG_LENGTH`, a private constant of 3; `parse-id.ts` caps a slug at 30 so `{persona}--{star}` fits one DNS label. *Adapted:* one exported persona-slug predicate, which the procedure's check (§ *The procedure, by example*) calls too.
- **The persona refresh.** `handleRefreshToken` in `packages/mesh/src/auth/worker-token.ts` mints a plain token on a persona's host, refuses any Star but `dev`, and logs the opener for ADR-016. It takes only an admin cookie as the opener, through `if (!persona) picked ??= exact`, so today P, a plain member of `acme.crm.dev`, is refused on `mary--dev.crm.acme.lumenize.dev`. *Adapted:* any cookie that would open `dev.crm.acme.lumenize.dev` opens Mary's page, the `'dev'` literal gives way to the persona-Star predicate (Missing 5), and the refresh asks the Galaxy whether the persona carries the admin mark.
- **A login that returns to a persona's host.** `checkedReturnTo` in `hosts.ts` accepts a persona kind, so a phone with no cookie logs in and comes back as Mary. *Carried unchanged.*
- **A persona page with no session.** The scaffold's client factory (`packages/resources/src/frontend/create-nebula-client.ts`) posts `lumenize:login-required` to Studio when framed and sends a top-level page to log in; `apps/nebula/container/app/src/nebula.ts` no longer redirects on its own. *Adapted:* on a persona's host its logout ends no session (§ *Decisions*).
- **Studio's preview.** `App.vue` frames one iframe at `devTabUrl(activeScope)`, and `onFrameMessage` accepts messages from that one origin, `lumenize:login-required` among them. *Adapted:* a strip of frames, one per open persona plus `Me`, each origin accepted; the richer login-failure notice stays the backlog's.
- **The scaffold's page title.** `apps/nebula/container/app/index.html` says `Nebula preview`. *Adapted:* the slug prefix on a persona's host.
- **The loop's tool table.** `LOOP_TOOL_ENTRIES` in `apps/nebula/src/galaxy.ts` names every Galaxy entry a tool may reach, and the resource-surface test asserts each sits at the chat floor, which is DAG `write` at the chat node, the check `requireChatWrite` makes. *Adapted:* it gains `provision` and `invite`. The chat-floor assertion stays, since each method a tool names still sits there, and the JSDoc says what a tool reaches may need more.
- **Three ways to wipe the dev Star.** Studio's Wipe button calls `Star.resetDevData()` with Studio's Galaxy-host token, which for Austen has no passage into `.dev`, and reports success anyway. `Galaxy.applyOntology({ wipe })` checks dominion over `.dev` and writes `wipeOnInstall` on its row, and the install wipes. The harness's reset helper calls `resetDevData`. Nothing in Studio calls `applyOntology`; harness scenarios call it without the flag, and two tests call it with the flag. *Left behind:* the button, `applyOntology` with its flag, check and the `wipeOnInstall` it writes, and `resetDevData` with its harness helper; provisioning becomes the one path. The three scenarios that call `applyOntology` apply through a build instead.
- **The turn trigger.** `#onChatCommitted` in `galaxy.ts` starts a turn for each human post on the chat node, but skips one that arrives while a turn runs, behind the in-memory `#turnInFlight` flag. *Adapted:* when a turn ends, posts that arrived during it get a reply from a turn the agent starts, which has no tools.
- **The agent's reply.** `commitAgentMessage` writes it with the poster as subject and `agent:lumenize` as actor, behind `pinnedAtPost`, whose only production caller it is. `deriveKind` in `participants.ts` calls a message the agent's only when its outermost `act` names the agent, and `Snapshots.#buildActingToken` throws on a write with no caller, since `projectActingToken` reads `claims.sub` off `undefined`. *Adapted:* every agent message names `agent:lumenize` as its subject with no `act`, `deriveKind` reads the subject too, and Snapshots takes a subject the server supplies, beside the actor it supplies today; `pinnedAtPost` goes.
- **Who may invite.** `AuthFacade.invite` admits a caller whose host is the target, so today Austen, a plain member of `acme.crm`, may invite anyone into `acme.crm`. *Adapted:* into a Galaxy only dominion invites, so her invite is refused; into a Star, peers still invite.
- **The `.dev` membership an invite mints beside the Galaxy's.** `issueInvites` in `auth-registry.ts` sets its admin bit only when the inviter has dominion over the Galaxy. *Adapted:* with every Galaxy inviter an admin, the branch that mints it without the bit is dead and goes, and an invitee who already holds a plain `.dev` membership is promoted, since `#mintIdentity` returns an existing row unchanged.
- **Passage for a chain a node started.** `claimsForPassage`, which `ScopedMeshDO`'s passage step calls, treats such a chain as a plain member of the starting node's scope, so a Galaxy's own chain has no passage into its Stars. *Adapted:* a Galaxy's chain is the admin of its own `.dev` Star and of nothing else.
- **Running a block under a call context.** `runWithCallContext` in `packages/mesh/src/lmz-api.ts`. *Carried;* `asPersona` (Missing 3) builds on it.
- **The Profile.** Its owner branch admits a token whose `profileId` is the Profile's own, and a persona's token carries its own. *Carried;* its JSDoc rests the branch on the impersonation mint's acceptance check, which persona claims never pass, so it is restated as the invariant that holds: no persona id can equal a person's, by construction.
- **The org tree.** `resources.orgTree.setPermission` through each host's `@mesh()`-decorated `get resources`. *Carried unchanged.*
- **The `.dev` wipe.** `Resources.#wipe` refuses any Star but `.dev`, and drops every resource, grant and subscription and the installed ontology. *Carried unchanged;* the cast record lives in the Galaxy, so a wipe leaves it.
- **The ontology the dev Star runs.** [nebula-star-ontology.md](archive/nebula-star-ontology.md) built it: the dev Star runs the last landed build's compiled row, which the Galaxy keeps in its own storage, and `applyOntology` goes. *Used as built there:* the hand-off carries that row.
- **The lazy ontology pull.** An op on a Star whose installed version differs asks the Galaxy for its current row and is refused as a temporary mismatch meanwhile. *Carried;* provisioning does not wait on it, because the hand-off carries the current row and the dev Star installs it before seeding.
- **The cast guidance.** `apps/nebula/container/app/docs/personas.md` and `apps/nebula/platform/skills/define-the-cast/SKILL.md` ship through `scaffold-seed.ts` and `platform-embed.ts`. Both key on the slug and name no address, but both still teach the `mint` verb, `define-the-cast` says a slug is 3 to 11 characters and that its step 6 is "a confirmed step outside this chat", and the template's worked step 1 mints `ollie` with `scopeAdmin` bundled into a grant. *Adapted.*
- **The harness's accept.** `provisionAndLogin` and `acceptInviteAndLogin` in `apps/nebula/test/lib/email-login.ts` accept with no nickname. *Adapted.*
- **The `persona-host` scenario.** It drives the persona refresh, with P, a plain member of the `.dev` Star, among the refused. *Adapted.*
- **Impersonation.** `impersonate()` is built and driven by `/live` scenarios. *Left behind:* a persona does not use it.

**Missing:**

1. **The procedure** — its TypeScript type, validated by typia, and the `provision` loop tool and Galaxy entry.
2. **The dev Star's provisioning entry**, which wipes, installs the ontology row it was handed, builds the tree, attaches the grants and seeds. It sits on a capability Star composes in `onStart` only when its own name is a `.dev` Star, in a module of its own, reached through one `@mesh()`-decorated getter, `get dev()`, that admits only a chain its own Galaxy started.
3. **`asPersona(node, slug, { admin }, fn)`**, in a module of its own in Mesh's auth layer, exported from `@lumenize/mesh/auth` and never from `/client` or `hosts.ts`. It builds the claims a persona's tab would carry and runs `fn` under them; the setup identity is the same call with the constant slug `_setup`. The Star is the node it is handed, read from its stamped name and refused unless the persona-Star predicate holds. The admin bit comes from the procedure, and the function checks no slug, since the procedure's check has already run.
4. **The Galaxy's hand-off rule.** The claims the passage step derives today, and after:
   ```ts
   // A chain the Galaxy acme.crm starts, today, whatever it calls:
   { aud: 'acme.crm', access: { authScope: 'acme.crm' } }          // passage up only
   // After, calling its own acme.crm.dev:
   { aud: 'acme.crm.dev', access: { authScope: 'acme.crm.dev', scopeAdmin: true } }
   // After, calling acme.crm.tenant1: unchanged, so passage is refused
   ```
   The chain carries no `sub`. These derived claims get it through passage; the `dev` gate then admits it because it carries no `originAuth` and its `callChain[0]` is this Star's Galaxy, which no Client's chain can match, since a Client's host stamps claims on every call. `requireDominionHere` is unchanged, and the wipe needs no claims. `OrgTree.requirePermission`, which throws `Authentication required` for a chain with no `sub`, never sees it, because every write after the wipe runs as the setup identity or a persona.
5. **The persona-Star predicate**, today only `dev`, which every decision about whether a Star holds personas asks; the Galaxy's own `.dev` Star stays a constant.
6. **The refresh's changes**: the opener rule, and the hook that asks the Galaxy for the admin mark through a `@rawRpc()`-decorated Galaxy method, since the refresh is raw Worker code.
7. **The cast record** in Galaxy storage, rewritten by each provisioning run.
8. **Studio's strip**: a tab per persona and `Me`, an open-or-copy link per persona, frame messages per persona host, and the open tabs in the URL; and a persona page's logout that ends no session.
9. **The invite rule**, the co-mint cleanup, and the agent's `invite` tool: an Austen through `Resources.invite`, a Galaxy admin through `AuthFacade.invite` with `scopeAdmin`, whose answer the agent posts from the handler.
10. **The guidance edits**, the scaffold's title, and the harness's nickname.
11. **The agent posting as itself**: the subject the server supplies, `deriveKind` reading it, and the turn the agent starts when a turn ends, with no tools.

## Design intent — a cast on hosts of its own

**Provisioning a cast is Galaxy work; being one is a page on the persona's own host.** In a poster's turn, the Galaxy hands the procedure to its dev Star, which builds the tree, attaches each persona's grants and seeds their data. Studio frames one host per open persona, and the page there gets a token as Mary from the cookie of the user-developer who opened it. Nothing is created in the Registry: Mary has no address, no membership, no invite to accept and no cookie of her own.

- **The risk test: every guard here answers one question, does it stop lateral movement or a production risk?** If neither, it goes. Risk is probability times cost, and someone taking control of a persona costs next to nothing, so nothing here is built to protect personas themselves. Lateral movement is reaching another Galaxy or a sibling Star; a production risk is writing as a real person or reaching a Star with real users. Both of those are a big deal, and every guard that survives stops one of them: the persona-Star predicate, the version-5 id `personaId` computes, `asPersona` reading its Star from the node it runs on, and the hand-off chain confined to its own `.dev` Star. The test governs guards on the testing machinery; who may join a Galaxy is goal 4's product rule, not a guard it judges.
- **Each persona has a host of its own, because the host is how one browser holds several identities at once.** In production every cookie in a browser belongs to one person, though perhaps to more than one of their Profiles. Personas are the one case where a browser acts as several people, and the host keeps them apart without a cookie each:
  - **The refresh reads the page's host from `Origin`, which page script cannot set.** So the host alone names the persona to mint, and nothing the page sends is an input. On the dev Star's own host the same cookie mints the opener, which is the `Me` tab.
  - **Browser state is per origin.** A Client keeps its tab id in `sessionStorage` and checks it for duplicates over `BroadcastChannel`, both per origin, so persona frames on separate hosts cannot collide the way frames sharing one origin would.
- **A persona's id is computed from its host, so nothing stores which id is whose.** Its `sub` and `profileId` are one value, `076af664-3cfc-5b39-b6ce-76a05dfbc224`: a hash of `acme.crm.dev/mary`, formatted as a version-5 UUID, from `personaId` in `packages/mesh/src/auth/hosts.ts`. The id is stored wherever it is used, in a grant or a seeded row, but no table maps Mary to it; every reader recomputes it. So a grant attached before Mary's tab ever opens names the `sub` her token will carry, and a `.dev` wipe changes nothing about who she is.
- **Everyone in the chat holds admin over the dev Star, so the chat floor gates the dev Star.** Only a Galaxy admin can invite anyone into a Galaxy, and an invite's `.dev` membership gets the admin bit whenever the inviter has dominion over the Galaxy, so every collaborator is a Galaxy admin or an Austen (goal 4). Provisioning, the one way to wipe the dev Star, therefore sits at the chat floor. That needs nothing more: a wipe reaches only the dev Star's test data, and every chat member holds admin over the dev Star anyway.
- **The Galaxy owns provisioning.** It runs the procedure in the poster's turn and hands it to the dev Star, and keeps the cast record itself: each persona's slug, name and admin mark. It hands off by an ordinary `lmz.call` on a chain it starts, and that chain acts as the admin of the Galaxy's own `.dev` Star and of nothing else (§ *Decisions*). Seeding runs on the server as each persona, so the list Sally creates is genuinely Sally's. Nothing reaps a persona's Profile: it holds only public fields that anyone can already read.
- **A persona's page gets its token from the cookie of whoever opened it.** ADR-022 allows that only in a Star with no real users, today only `.dev`, and only where the cookie could open the Star's own page. Studio frames one such page per open tab.
- **The token is plain:** a persona's `sub` and `profileId`, `acme.crm.dev` as `authScope` and `aud`, and no `act`. Mary, as the account's admin, also carries `scopeAdmin`; Sally and Gerry do not. ADR-022 trades attribution for testing fidelity here, which costs nothing on a Star with no real users.

**It took three wrong turns to get here, and each is the obvious first answer.**

1. **Each persona gets a real session, minted and accepted on the server**: the Galaxy mints each persona a membership, accepts its invite off inbound mail, then writes that persona's data by impersonating it. A Durable Object holds `callContext.originAuth`, which is verified claims rather than a replayable credential, so it has no session to mint from, and seeding runs after the mail round trip, by which time nothing holds the authority to do it. What survived is the server doing the work: the dev Star builds the cast and seeds it as each persona, under the claims a persona's tab would carry rather than a session.
2. **Tabs run under impersonation**, minted by Studio off the user-developer's own session and handed into each iframe. The parent has to hand a renewal closure across a realm boundary, which a client cannot take (`testing.md` § *Driving a DO under a token you were HANDED*), and whose failure is a tab quietly renewing as the user-developer while its label still reads `mary`. A tab also outlives the user-developer's logout, and the gate meant to select a persona tab cannot tell the user-developer's own. Impersonation stays what it was built for, the admin-debug flow in [backlog.md](backlog.md) § *Nebula Studio UI*; a persona tab is not it.
3. **Every tab is a real login** (2026-09-09 to 2026-09-18): a real account per persona at `acme.crm.dev~mary@personas.lumenize.io`, a refresh cookie per membership so eight tabs at one scope stop overwriting each other, and the invite link handed to Studio instead of a mailbox. Two of its parts sat in the code that issues real memberships: a membership born accepted, an exception to [ADR-012](../docs/adr/012-global-profile-visibility.md)'s rule that authority rests on an accepted membership, and guards keeping every human out of the persona addresses. A mistake in either reaches real people, which the risk test counts as a production risk. A persona with no address needs neither.

### The order provisioning runs in

Deliberately not pinned (Larry: *we'll have to evolve this with trial and error*). Provisioning does one pass on the server, in the poster's turn, and a tab only frames a host.

1. **On the Galaxy, in the turn that follows the person's yes:** check the chat floor, validate the procedure, write one ADR-016 record of the poster's full claims, and hand the procedure to the dev Star, with the last build's compiled row, on a chain the Galaxy starts.
2. **On the dev Star:** wipe and install the ontology row; then, as the setup identity, create each **node** and **edge**, and **grant** each persona its tier, naming `personaId(star, slug)`.
3. **Still on the dev Star, as each persona in procedure order:** write its name, then its data steps.
4. **Back on the Galaxy:** rewrite the cast record from the procedure, and post the outcome to the chat as the agent: the realized tree, or the step that failed and why. An agent message starts no turn, so the person sees it at once and the model reads it on its next turn.

Every run starts from an empty dev Star and every persona keeps its id, so a run after an edit and a run after a wipe are the same run. Installing the handed-over row before seeding means a freshly wiped Star never refuses its own provisioning as a version mismatch.

### The procedure, by example

`crm`'s `docs/personas.md`, as the model writes it with Jennifer:

```markdown
- `mary` — Mary Manager. Set up the account and invited the team. The account's admin.
- `sally` — Sally Sales. Works her own deals.
- `gerry` — Gerry Guest. A contractor who sees only the deals he is added to.

1. Create `deals` under the root, and `acme` under `deals`.
2. Grant `sally` `write` on `deals`; grant `gerry` `read` on `acme`.
3. As `sally`, create a Deal "Acme renewal" in `acme`, and a Deal "Globex pilot" in `deals`.
```

The procedure the model derives from it, typed and validated before `provision` runs. The field names and the verb `create` are provisional, for Pass 2 to pin:

```ts
{
  cast: [
    { slug: 'mary', name: 'Mary Manager', admin: true },
    { slug: 'sally', name: 'Sally Sales' },
    { slug: 'gerry', name: 'Gerry Guest' },
  ],
  steps: [
    { verb: 'node', ref: 'deals', parent: 'root' },
    { verb: 'node', ref: 'acme', parent: 'deals' },
    { verb: 'grant', slug: 'sally', node: 'deals', tier: 'write' },
    { verb: 'grant', slug: 'gerry', node: 'acme', tier: 'read' },
    { verb: 'create', as: 'sally', type: 'Deal', node: 'acme', ref: 'renewal',
      value: { title: 'Acme renewal' } },
    { verb: 'create', as: 'sally', type: 'Deal', node: 'deals', ref: 'pilot',
      value: { title: 'Globex pilot' } },
  ],
}
```

A `ref` is a handle local to the procedure. `root` is reserved and names the Star's existing root node; the dev Star mints a real id for every other `ref` at the step that first names it and puts it wherever a later step names that `ref`, so a step can point at a node or a resource an earlier step made, though every run mints fresh ids. The outcome the agent posts: *"Provisioned the cast: Mary (admin), Sally and Gerry; 2 nodes, 2 grants, 2 deals."* In Gerry's tab, "Acme renewal" shows and "Globex pilot" does not.

## Constraints

- **[ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md)** sets a persona's host, its token and who may open it.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** binds every guard here.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)** binds provisioning, which destroys state and attaches grants. The Galaxy writes one record of the poster's full claims through the shared projection before the hand-off, through `projectActingToken`.
- **[ADR-023](../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)** routes the refresh's question about the admin mark: `handleRefreshToken` is raw Worker code, so it calls a `@rawRpc()`-decorated Galaxy method through a hook the platform supplies from `apps/nebula/src/scope-lifecycle-hooks.ts`, as `ScopeLifecycleHooks` does. That adds one Galaxy hop to each persona refresh.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)** decides what a denied persona sees: the denied-node set, disclosed.
- **[ADR-017](../docs/adr/017-the-url-is-the-view-state.md)** puts the open tabs in the URL, and never a credential.
- **[ADR-001](../docs/adr/001-typescript-as-schema.md)** types the procedure in TypeScript, validated by typia.
- **[ADR-006](../docs/adr/006-resources-reference-by-id.md) and [ADR-010](../docs/adr/010-random-opaque-keys.md)** keep seeding from deriving a resource's id from a label: the seed mints fresh ids, which is safe because every run starts from an empty dev Star.
- **[ADR-012](../docs/adr/012-global-profile-visibility.md)** makes a persona's Profile readable by anyone holding its id, which is why nothing reaps one; its acceptance tripwire still binds every real membership.
- **Rules:** `live.md` makes `/live` the first tier and the sweep a phase criterion; `studio-guidance.md` says where each guidance edit lives and that the embeds are regenerated.
- **Standing guidance this task changes, each in the phase that changes what it describes:**
  - `security.md`: the line on a chain a node started, its rule that no synthetic `aud` is written into `originAuth`, which the persona function meets once and the hand-off meets by writing nothing there, and `applyOntology`, which leaves the list of source entries at the chat floor along with its wipe bit.
  - `mesh.md` § *Passing data to the callee*, which says `originAuth` is always verified from a JWT.
  - `website/docs/nebula/auth-flows.md` § *A persona's page*, on who opens one and on `scopeAdmin`.
  - `security.md`'s bullet on a turn's authority pinned at its post, whose reply no longer rides the pin, and the tool contract in `codegen-loop.ts`, which tells the agent to address the person and ask before acting on anything it was not asked directly.
  - `docs/vision/auth.md` § *When the agent acts*, amended in place on 2026-10-10.
  - `security.md`'s rule that a derived session never logs out through the originating one, which gains the persona page as its second case.
  - The JSDoc of `Profile.#requireOwnerOrAdmin`, restated as the invariant § *Current state* names.
  - `apps/nebula/platform/skills/define-ontology/SKILL.md` step 6, which becomes: the preview runs the new types after the build, and a change that removes or retypes a field existing data uses asks to provision.
  - The JSDoc of `AuthFacade.invite`, `Resources.invite`, `issueInvites`, `#buildAndAnnounce`, `getCurrentOntology`, the Galaxy's file header, `LOOP_TOOL_ENTRIES`, `#onChatCommitted`, `handleRefreshToken`, `requireDominionHere`, `NEBULA_SUB`, `commitAgentMessage`, `deriveKind` and the header of `participants.ts`.
  - The header of `apps/nebula/src/codegen-loop.ts`, which calls the loop's lack of any install or wipe path a guarantee. `provision` ends that, so the header changes in the phase that adds the tool, and its `D2` handle becomes prose.
- **Milestone:** pre-alpha, deploy gate. Jennifer and Austen are the first users of it.

## Future state

- ⚠️ Design consideration: **a phone's first login may prove to be friction.** The fix then is a Studio QR code that hands the phone a session good only for that dev Star's persona hosts; by the risk test such a session reaches nothing of value.
- ⚠️ Design consideration: **a Star other than `dev` may hold personas**, `test` say, once someone decides it has no real users. The persona-Star predicate is the one place that changes.
- ⚠️ Design consideration: **when an app emails one of its users and the user is Mary, the mail goes nowhere today.** The address is whatever the seed wrote. The options are a reserved domain such as `example.com`, a platform catch-all Studio shows as each persona's inbox, or nothing until [nebula-outside-world.md](nebula-outside-world.md) builds its email recipe, which is the trigger either way.
- ⚠️ Design consideration: **every persona opening by default is a trial.** Each loaded tab is a token, a socket, a set of subscriptions and a copy of the app, so the cost grows with the tabs someone has viewed. Watch Studio's time to usable after a build, and how many sockets the dev Star holds. If it bites, unload a tab when it leaves view; failing that, open `Me` alone.
- **The request-access task** builds on the same subject, grant and scope core (§ *Relationships*).

## Open questions

None left here. The third Stage 1 pass reopened five on 2026-10-10: the split and the provisioning door were decided the same day (§ *Decisions*), and the other three moved with the redesigns they belong to. Whether a build's ontology reaches tenant Stars before anything is published is [nebula-star-ontology.md](archive/nebula-star-ontology.md)'s; what the agent's own turn may read, and what an agent message's byline shows, are the agent's-voice task's.

## Decisions

| Decision | Why, and what it beat |
|---|---|
| **A persona has no address, membership, invite or cookie; its page gets a plain token from the cookie of whoever opened it.** | [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md), 2026-09-18 (Larry). Beat impersonated tabs and a real login per persona, the wrong turns § *Design intent* describes. |
| **Every guard answers the risk test: does it stop lateral movement, or a production risk?** | 2026-10-09 (Larry); § *Design intent* states it. What it removes from today's code: the dominion floor on persona tabs, `applyOntology` with its wipe check, the `.dev` co-mint's branch without the bit, and Studio's Wipe button with `resetDevData`. |
| **A persona is keyed on its slug, never its `sub` or name.** The model writes a slug and a name; our code computes the host and the id. | 2026-09-09 (Larry). The tab label, the host and the id all derive from the slug, so a rename is a new persona, and the next run's wipe drops the old one's grants. The name is display only. The model cannot compose a host: nothing it sees carries `{u}.{g}`. |
| **A slug is valid exactly when its host parses**: 3 to 30 characters that pass `isValidSlug`, through one exported predicate. | 2026-10-09. One grammar, not a copy, and the 3-character floor already refuses `me`, so `me` needs no check of its own. The guidance stops teaching "3 to 11", which nothing enforces. Beat: a copy of the regex in the procedure's check. |
| **Which Stars hold personas is one named predicate, today only `dev`; the Galaxy's own `.dev` Star is a separate constant.** | 2026-10-09; the split 2026-10-10. Every decision about whether a Star may hold personas asks the predicate, and the refresh's own `'dev'` literal goes. The hand-off rule, `Resources.#wipe` and `issueInvites`' co-mint name the Galaxy's own `{galaxy}.dev`, which is a fact about the Galaxy rather than about personas, so they keep the constant. `parseHost` keeps parsing every reserved environment Star, so `manny--staging` still parses and the refresh refuses it with a 401, as `persona-host`, `auth-flows.md` and ADR-022 assert. Beat: `RESERVED_STAR_SLUGS`, which holds `prod` to stop squatting, so `mary--prod` parses and only the refresh refuses its token; and the predicate inside `parseHost`, which turns that 401 into a 403 with no CORS headers. |
| **`docs/personas.md` is the one authored artifact**: numbered prose, keyed on slug, from which the model derives a typed **procedure** per run. | 2026-09-08/09 (Larry). A procedure is executed over and over and evolves, so the word is never "plan". Beat: a script the model writes, which a person cannot refuse the way they refuse prose; and committing the derived procedure beside the prose. |
| **Every provisioning run starts by wiping the dev Star, once the person who asked confirms, then builds the cast, its grants and its data from the procedure.** The dev Star's provisioning entry is deterministic and returns the realized tree. | Decided 2026-10-09 (Larry), reversing 2026-09-09's "provisioning never wipes". A forced wipe is acceptable because the procedure seeds the test data again, and it deletes convergence, the empty-node rule for seeding, and any reasoning about a half-built run. Wiping and provisioning now share the chat floor, so the old reason, keeping the wipe a separately gated act, is gone. The cost: each run discards test data made by hand in the preview, and anything the app built there. The confirmation is required because a wipe destroys that. Beat: only creating what is missing, which cannot remove a persona or move the admin mark; converging what provisioning owns, which needs a diff against the cast record; and a tool per step, or a typed block Studio parses, from 2026-09-04. |
| **The model asks in chat before calling `provision`, unless the person asked for the wipe themselves.** Its reply names what the wipe destroys and the cast it will build, and its turn ends; the person's yes is a post, which starts the turn that calls `provision`. A post that itself asks to reset or wipe the test data is its own yes. `provision` is a loop tool in `LOOP_TOOL_ENTRIES` like any other, at the chat floor, which § *Design intent* argues is its whole guard. | 2026-10-09 (Larry); the explicit-request clause 2026-10-10, under the rule that a direct request is its own go-ahead. The confirmation protects test data made by hand in the preview, which a wipe destroys; someone asking for the wipe has made that choice already, while someone asking only to provision the personas may not know every run wipes. For now it is a chat exchange; later a button in the chat answers for the person. An unasked wipe costs only test data, which the run seeds again, so the risk test asks for no enforcement. A yes that arrives while a turn is running is answered when that turn ends (below). Beat: staging the procedure behind a confirm card in Studio, which adds a pending procedure and a UI for a guard the risk test prices at nothing; a brokered ask on refusal, since nobody at the chat floor is refused; dominion over `.dev` from Studio, which no token on the Galaxy's host can carry without `aud` sitting above `authScope`; and dominion over the Galaxy for every collaborator, which reaches every tenant Star. |
| **Every wipe of the dev Star goes through `provision`.** Called with no cast it is a plain wipe; called after a breaking ontology change it wipes, installs the new types from the hand-off, rebuilds the cast and seeds. Studio has no Wipe button; resetting is asking in chat. | Decided 2026-10-09 (Larry). One path replaces three, and the button's silent failure for Austen goes with the button. Each reason a wipe might be needed, a breaking change to the data model, a changed cast or changed test data, is a reason to call `provision`. Beat: keeping the button and routing it through a Galaxy entry, which leaves the cast without grants until someone asks the model; and a button that posts a reset request into the chat, which is the in-chat button planned for later. |
| **The hand-off carries the last build's compiled row.** | [nebula-star-ontology.md](archive/nebula-star-ontology.md) decided how the dev Star comes to run the last build's ontology, and that only the Galaxy's own `.dev` Star follows it until something is published. |
| **A turn a person's post starts acts as that person; a turn the agent starts only talks.** When a turn ends, the agent checks the thread, and if anyone posted during it, starts a turn of its own with no tools: it reads the thread, addresses whoever needs an answer, proposes, and asks *"Should I proceed?"*. Their yes is a post, which starts a turn that acts as them. A direct request is its own go-ahead, as today; the asking is guidance in the tool contract, not a check. The agent's turn runs outside the ending turn's call context, so a tool given to it by mistake finds no `sub` and is refused. | Decided 2026-10-10 (Larry), replacing 2026-10-09's hold. A turn can do nothing without a human's permissions, not even post its reply, so a held post's turn ran as whoever's turn had just ended: Austen's held invite would have run as Jennifer. A turn that only talks needs nobody's. Nothing is held or stored, so an eviction mid-turn loses only the catch-up, and the posts wait in the thread for the next turn. A yes that lands before the asking reply commits is answered by the catch-up, which asks again. Fast-follow Item 6 keeps the discriminator, which Larry calls a cost optimization for later, and steering a turn mid-generation. Beat: holding the post in memory and starting its turn under the context captured at its commit, which works but leaves every catch-up borrowing someone's permissions; storing the held post's id, whose turn ran as the previous poster; replaying its stored acting token, which ADR-016 forbids as an authz input; and skipping the post, as today. |
| **The agent posts to the chat as itself.** Every agent message names `agent:lumenize` as its subject, with no `act`. The server composes it as it composes the actor today, only `commitAgentMessage` can supply it, and it is only ever a chat Message, which passes no permission check. | Decided 2026-10-10 (Larry), amending `docs/vision/auth.md` § *When the agent acts*, which had the agent only ever an actor. That section's objection was to a login, which grants authority that then has to be confined; this confines one thing, a chat post. What a turn writes stays *this human, via Nebula*. `deriveKind` reads the subject in the same commit, or the agent's own post reads as human and starts a turn that answers itself. Provisioning's outcome message is one of these, which settles who it names. Beat: the poster as every agent message's subject, as today, which leaves the agent's own turn nobody to post as; and the agent as subject only in its own turns, which makes two shapes of agent message. |
| **A Galaxy has two kinds of collaborator, and only a Galaxy admin invites anyone into it.** An Austen gets DAG `write` at the chat node, never DAG `admin` there; a Galaxy admin gets `scopeAdmin` on their Galaxy membership. Peer invites into a tenant Star stay open. | 2026-10-09 (Larry); goal 4. Every invitee's `.dev` membership then carries the admin bit, and one they already held plain is promoted, so a test user invited straight into the dev Star who later joins the Galaxy becomes an Austen too. Only a Galaxy admin's deliberate grant at the chat node to someone outside the Galaxy makes a third kind: a member of `acme.crm.tenant1` has passage up into the Galaxy, so with that grant they can chat and provision from their tenant's page. By the risk test that costs the dev Star's test data and nothing more. |
| **The agent invites both kinds of collaborator, by two paths, and Austen is refused further down.** Jennifer writes *"I wish our UX designer could participate here"*; the agent asks for the address and whether they should invite others and see the tenants' data (a Galaxy admin) or mostly help build the app (an Austen), and her yes calls `invite`. An Austen goes through `Resources.invite(chat node, [{ email, tier: 'write' }])`, which checks DAG `admin` at the chat node and answers within the turn. A Galaxy admin goes through `AuthFacade.invite('acme.crm', [{ email, scopeAdmin: true }])` over `lmz.call`, whose answer lands in a Galaxy handler that posts the outcome as the agent. In Austen's turn the chat node's check refuses the first and the facade's Galaxy rule the second, and the agent then puts her request to a Galaxy admin in the thread. Every Galaxy method a tool names still sits at the chat floor, so the resource-surface test's assertion stays. | Decided 2026-10-09 (Larry); the two paths 2026-10-10. The tool acts only with the poster's own authority, and `codegen.toolCalls` records each call. An invite sends an email, which [`_ai-security.md`](../docs/vision/_ai-security.md) § *Where reversibility stops* names as permanent; it is accepted because the email goes only where the poster asked, under authority the poster holds, and the agent asks which kind before it sends. A line planted in `AGENTS.md` to steer the owner's turn is visible and traceable, and the owner answers for whom they invited. The 2026-09-04 rule that no tool above the chat floor joins the loop ([archive/nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md)) is retired for what a tool reaches, never for the method it names: a loop tool calls in-process, where a decorator's guard does not run, so the assertion keeps a later tool from reaching `setGalaxyConfig` unchecked. The facade's Galaxy rule matters, because today it caps a peer's `scopeAdmin` to `false` rather than refusing it. A refused invite points at [backlog.md](backlog.md)'s *Nebula as permission broker in chat*. Beat: inviting only an Austen from chat, which drops the question the agent asks; an invite screen; a confirm card; and a fixed confirmation the Galaxy writes, answered by a typed `yes`. |
| **The Galaxy hands provisioning to its dev Star by an ordinary `lmz.call`, on a chain it starts, and that chain is the admin of the Galaxy's own `.dev` Star and of nothing else.** | 2026-10-09 (Larry). The rule's scope is derived from the callee, so it cannot widen to a tenant. Beat, for the hand-off: ADR-023's `@rawRpc()` bridge, which crosses the mesh boundary rather than getting around `lmz.call`, carries no claims and flattens typed errors; and the dev Star pulling the procedure later, whose outcome would never reach the turn. |
| **The Galaxy's chain carries no `sub`, and the dev Star builds the tree and grants as a setup identity.** The chain gets through passage on the hand-off rule, passes the `dev` gate because its own Galaxy started it, and wipes. The nodes, edges and grants are then written as `_setup`, displayed as "Setup": a version-5 id computed from `acme.crm.dev/_setup` by the persona function, admin of the dev Star and of nothing else. The poster is named once, in the ADR-016 record the Galaxy writes before the hand-off. | Decided 2026-10-10 (Larry). No path writes as a real person, and one function builds every identity provisioning writes as. The underscore keeps it server-only: `isValidSlug` refuses it, so `parseHost` maps no host to it and the procedure's check refuses it in a cast, while `personaId` hashes any string. Nothing is written into `originAuth` for the chain. Beat: the poster as the subject, which needs code that builds a real person's `.dev` admin claims from a token that said `acme.crm`, one bug from writing as someone who did not ask; and the cast's admin persona, closest to a real tenant but needing this identity anyway when a cast has no admin. |
| **A `.dev` Star's own behavior is a capability composed per instance, behind one gate.** Star's `onStart` builds it from a module of its own only when its name is a `.dev` Star, and `@mesh() get dev()` returns it or refuses; its guard admits only a chain the Star's own Galaxy started. The provisioning entry is its first member, called as `ctn<Star>().dev.provision(…)`. | Decided 2026-10-10 (Larry). It closes the third Stage 1 pass's widest hole: under `requireDominionHere`, any `.dev` admin, or code in a persona's tab, could hand the entry a validator bundle that tenant Stars then load from the shared facet cache. ADR-007 makes per-type behavior a capability composed onto a node, never a node type. Beat: a `DevStar` subclass, which needs a binding of its own, so every place that turns a scope into a binding needs a `.dev` case; a mixin, which is class-level and so reaches every Star or needs that binding too; and `requireDominionHere` reading the claims passage derives, which widens a guard every `@mesh(requireDominionHere)` site shares. |
| **Seeding and each persona's name run on the server, as that persona.** `asPersona` builds the claims the persona's tab would carry and runs a block under them; every existing check then runs unchanged. | 2026-10-09 (Larry). Only a page on Mary's host can get Mary's token, and a step like *"as `gerry`, add two todos to it"* needs `sally`'s step done first. The subject only ever comes from `personaId`, and the Star from the node the function runs on, so it can never be a person's or another Galaxy's. Beat: a hidden frame per persona, one workflow spread over N frames that [ADR-014](../docs/adr/014-container-companion-do-is-the-hub.md)'s general rule warns against; seeding as each tab opens; `ensureResource`'s `actor`, which keeps the poster as the subject; and a second caller of `setDisplayNames` writing each name from outside, which running as the persona makes unnecessary, since the name then goes through the Profile's owner branch as a person's does. |
| **`asPersona` takes the node, the slug and the admin bit, and is exported from `@lumenize/mesh/auth`.** `await asPersona(this, 'mary', { admin: true }, () => …)`. The bit comes from the procedure the dev Star was handed. | Decided 2026-10-10 (Larry), reversing 2026-10-09's "takes only a slug" and "stays off Mesh's public exports". The dev Star cannot read the Galaxy's cast record mid-run without holding a reply open across a hop (ADR-003), and the record is rewritten only after seeding, so a slug alone builds Mary with no admin bit, and the org tree refuses her steps. Every Mesh subpath is public and the callers live in other packages, so no unexported home exists; and by the risk test none is needed, since the function builds claims only for personas of the `.dev` Star it runs on. Beat: a `protected` method on `ScopedMeshDO`, which puts a member only a `.dev` Star uses on every scoped node and which the Resources plane, not a subclass, cannot call; and a method keyed by a symbol private to Mesh, which a caller in Nebula cannot reach. |
| **Nothing here reaches a Star with real users, and only someone who can already open a dev Star's page reaches its personas.** Larry's line, 2026-10-10: reaching a `.dev` Star as a collaborator on its Galaxy is fine; reaching any other Star from a non-`.dev` Star is not. | Five facts hold it, each with a criterion. (1) `asPersona` builds exactly the claims the persona refresh mints, and only on a node the persona-Star predicate admits. (2) Those claims carry `aud` and `authScope` of the `.dev` Star: passage upward, as every member of it has, and dominion, for Mary and `_setup`, over that Star alone; a call from them into `acme.crm.tenant1` is refused at passage. (3) The dev Star's provisioning entry admits only a chain its own Galaxy started, so Austen's tab, Mary's tab and the code running in either are refused there, and the Galaxy's one caller is provisioning, behind the chat floor. (4) `_setup` has no host, so no tab can be it. (5) A persona tab opens only for a cookie that could open the dev Star's own page: a Galaxy collaborator, a Galaxy or Universe admin, or someone a collaborator invited straight into the dev Star, and `dev` is a reserved slug no self-signup can claim. The last of those can open Mary's tab and act as the dev Star's admin, which stays inside that Star (2026-10-09, *A persona tab opens…*). |
| **The test data is prose steps in the same procedure, each written as its owning persona**, and seeded once per persona per relationship `docs/permissions.md` declares. | 2026-09-09 (Larry). A user-developer edits the data the way they edit the cast. typia checks the step's envelope; the Resources plane checks the content against the installed ontology. Beat: leaving it out of scope, which leaves the tedium § *Context* names; and a second authored file. |
| **One persona may carry `scopeAdmin` at the dev Star, as the account's admin, and the guidance proposes exactly one.** `grant` never carries the bit. | 2026-10-09 (Larry), reversing 2026-09-09. A tenant's founder holds the bit in production. The `Me` tab is not a substitute: its token rests on the user-developer's own membership and owns none of the seeded data. Everyone else gets grants alone, since the bit bypasses the org tree. |
| **The cast record lives in Galaxy storage: per persona `{slug, name, admin}`, rewritten by each provisioning run from the procedure the model derived, and it survives a `.dev` wipe. Nothing reaps a persona's Profile.** It is the procedure's `cast` array as written, never its `steps`. Studio's strip reads it from the Galaxy, and the refresh's hook asks the Galaxy for the admin mark. It stores no procedure: after a wipe the model calls `provision` again and derives a fresh one from `personas.md`. | Decided 2026-10-09 (Larry), revising the same day's choice of an admin mark in the dev Star. Studio's page is on the Galaxy's host, so for Austen it cannot read the dev Star; the strip needs every slug, while only the admin persona carries a mark; and the mark is a property of the scope, like a real membership's admin bit, which a wipe leaves alone. Beat: the admin mark alone in the dev Star, which names only Mary; a cast table in the dev Star, which a wipe empties and Studio cannot read for Austen; listing the cast from `personas.md`, which says what is wanted rather than what was built, and cannot name a persona just removed; replaying a stored procedure after a wipe, which a breaking ontology change can invalidate and which would make the derived procedure a stored artifact; and a run record under `.nebula/`, considered and never built. A persona's Profile is readable by anyone who computes its id, so reaping one protects nothing. |
| **A persona tab opens for anyone who could open the dev Star's own page.** | 2026-10-09 (Larry). The dominion floor stopped only people already inside the dev Star, such as a test user invited straight into it, which the risk test prices at nothing. Deleting it deletes a special case: the refresh's persona branch stops skipping the fallback to the membership at the Star. |
| **A persona page's logout ends no session; it disposes the page's client and goes nowhere.** | 2026-10-10. A persona page holds no cookie of its own; it refreshes off the opener's, so it is a derived session, and `security.md` says a derived session never logs out through the originating one. Its `/auth/logout` would end every session the browser holds, the opener's real ones included, which matters most on the own-host link a phone opens. |
| **The strip lists the whole cast plus `Me`, and every one opens by default; the URL then carries which are open.** A tab's frame first loads when the tab first comes into view, and stays loaded after; a build reloads the tab in view at once and each other loaded tab the next time it comes into view. Each persona also opens on its own host, and on a persona's host the page title starts with the slug, as `mary · Groceries`. | 2026-09-09 and 2026-10-09 (Larry). Every tab opening by default is a trial, reversing 2026-09-09's choice not to open them all: start there, and fall back if it bites (§ *Future state*). Loading on first view is Larry's: it keeps every tab open while paying only for the ones someone looks at, and reloading the rest on their next view spares a build from reloading every frame at once. Jennifer's practice is several tabs open, two personas at a time. The own-host link is mostly for a real phone: open the tab, copy the URL, send it. `Me` is the user-developer's own session, and the Galaxy's creator holds no `.dev` membership to be a persona with. |
| **A denied persona sees its denials disclosed**, never an error page or a silent empty view. | ADR-008 decides it. The guidance that teaches a generated app to render it is [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Denied access in generated apps*; this task asserts the data plane's `deniedNodes`. |
| **A blank tab from the app's own bug is ③'s to diagnose,** and personas is its trigger. | 2026-09-09 (Larry). The channel folds into [nebula-pre-alpha.md](nebula-pre-alpha.md) § *③ Capture live*. |

## Criteria — what the phases must satisfy

**Coverage.** `live.md` makes `/live` the first tier, and nothing here is pure: a real refresh off a real login's cookie, a real provisioning run, a tab strip. Two gating scenarios split on `needsContainer`, because seeding needs an ontology and only the container's build compiles one; the model's own part rides a third that does not gate:
- **`personas-provisioned`, with no container, about 13 s.** Claim a Galaxy and call its provisioning entry directly with a typed procedure of nodes, edges, grants and an admin persona, no data. Read the tree, the grants, the cast record, each persona's name and the admin persona's `scopeAdmin`. Then provision again: each persona keeps its id.
- **`persona-tabs`, with a container, about 110 s.** Build an app with an ontology, which applies it, provision with data steps, and open two tabs: each renders the app as its persona with no login by the user-developer, a second provisioning replaces the data rather than adding to it, and the denied persona's subscription answers with `deniedNodes`.
- **`studio-guidance-loop`, a limb that does not gate.** From `docs/personas.md` the model derives a procedure, asks before provisioning, and calls `provision` in the turn the answer starts.

⚠️ **A mutation per limb, never per scenario,** since a scenario reddens on its first failing limb and hides every later limb's vacuity. Where a limb asserts a refusal, match the message: a boundary refusal and a dominion refusal are the same boolean. `drive.ts all` is a phase criterion, and the guidance edits ride `studio-guidance.md` § *Changing what the model is told*.

**A deployed pass closes the build,** since it changes the refresh, `AuthFacade.invite`, `issueInvites` and the build-box image (`live.md` § *Two venues, one registry*). Before deploying, check the harness's deployed-only branches against the changed refusals; then run `deploy-test.sh`, and `persona-host`, `personas-provisioned` and `persona-tabs` with `HARNESS_TARGET_URL`, beside a `wrangler tail` capture.

**Criteria:**

- **Provisioning twice leaves the same cast,** each unchanged persona keeping its id, and the second run's data replacing the first's rather than adding to it. The limb counts each seeded Deal title once. Mutation: skip the wipe, and the second run either fails or doubles its rows, and the count reds.
- **The tree and grants are written as the setup identity, which nothing outside provisioning can name.** A provisioned node's record names `personaId('acme.crm.dev', '_setup')`; `parseHost` refuses `_setup--dev.crm.acme.lumenize.dev`, and a procedure naming `_setup` in its cast is refused before anything runs. Mutation: let `isValidSlug` accept a leading underscore, and the host parses.
- **A later step finds what an earlier step made by its `ref`.** Mutation: mint a fresh id where a `ref` is named again, and the second step points at nothing.
- **Persona claims built on `acme.crm.dev` always carry `aud` `acme.crm.dev`.** Mutation: let the function take the Star as an argument, and code on `acme.crm.dev` builds a persona of `globex.x.dev`.
- **`asPersona` refuses on any Star the persona-Star predicate rejects.** Handed `acme.crm.tenant1`, it throws before running its block. Mutation: drop the predicate check, and the block runs on the tenant as a persona.
- **A persona's claims stop at its own `.dev` Star.** Inside an `asPersona` block as Mary on `acme.crm.dev`, a call to `acme.crm.tenant1` is refused at passage. Mutation: build the claims at the Galaxy's scope, and the call passes.
- **Only a Galaxy collaborator reaches provisioning.** A member of `acme.crm.tenant1`, who has passage up into the Galaxy, is refused at the Galaxy's `provision` entry's chat floor. Mutation: drop the floor, and the tenant member's call wipes the dev Star.
- **Only the Galaxy's own chain passes the dev Star's `dev` gate.** Austen calls `dev.provision` straight from her `.dev` tab, handing it a row of her own, and is refused with the gate's message. Mutation: guard the gate with `requireDominionHere`, and her call wipes the Star and installs her row.
- **The model asks before it provisions, unless the person asked for the wipe.** The cast guidance tells it to name what the wipe destroys and the cast it will build, then end its turn, and to treat a post that asks to reset the test data as its own yes. A `studio-guidance-loop` limb asks only to provision the personas, and checks that the first reply asks and calls no `provision`, and that the answer's turn calls it. Mutation: drop the guidance line, and the limb sees `provision` called in the first turn.
- **Each persona's name shows the moment its tab opens.** Mutation: drop the name write, and the Profile answers with `NEVER_WRITTEN_ETAG`, `00000000000000000000000000`.
- **Only the persona marked as the account's admin carries `scopeAdmin`**, and the mark survives a `.dev` wipe. Mutation: have the refresh skip the Galaxy's answer, and the admin persona's token is plain.
- **A Galaxy's own chain is the admin of its own `.dev` Star, and of nothing else.** It passes the provisioning entry's dominion check there, and the same call aimed at a tenant Star is refused at passage. Mutation: derive the rule from the Galaxy's scope instead of the callee, and the tenant call passes.
- **The agent invites each kind of collaborator by its own path, and only for a Galaxy admin.** One limb per kind, each read off the invitee's memberships: Jennifer's Austen-kind invite leaves a plain Galaxy membership and an admin `.dev` one, and her admin-kind invite leaves a Galaxy membership with `scopeAdmin`. In Austen's turn both are refused, each limb matching its message: the chat node's `admin permission required on node …` and the facade's Galaxy rule. Mutations, one per limb: send the admin kind through `Resources.invite`, and the invitee holds no `scopeAdmin`; restore `memberHere` at the Galaxy tier, and Austen's admin-kind invite lands as an Austen.
- **Only a Galaxy admin invites into a Galaxy.** A plain Galaxy member's invite is refused at `AuthFacade.invite`, and a peer's invite into a tenant Star still lands. Mutation: restore `memberHere` at the Galaxy tier, and Austen's invite lands.
- **An invite into the Galaxy promotes a plain `.dev` membership the invitee already holds.** The fixture is P, invited straight into the dev Star, later invited into the Galaxy by Jennifer. Mutation: leave `#mintIdentity`'s existing row unchanged, and P stays plain at `.dev`.
- **Austen provisions from Studio, which wipes the dev Star.** Mutation: make dominion over the dev Star provisioning's floor, and Austen is refused.
- **Provisioning is the only path that wipes the dev Star.** `Resources.wipe()` has one caller, the dev Star's provisioning entry, and `resetDevData` appears nowhere under `apps/` or `packages/`; [nebula-star-ontology.md](archive/nebula-star-ontology.md) deleted `wipeOnInstall` and `applyOntology`.
- **A post that arrives during a turn gets a reply when the turn ends, from a turn that only talks.** Austen posts while Jennifer's turn runs; once it ends, a reply names `agent:lumenize` as its subject with no `act`, and the turn behind it was offered no tool. Mutations, one per limb: drop the catch-up, and Austen's post sits unanswered; assemble the catch-up with the loop's tools, and the limb sees them offered.
- **The agent's own message never starts a turn.** Mutation: leave `deriveKind` reading only `act`, and the agent's reply starts a turn that answers itself.
- **A persona page's logout ends no session.** On Mary's own host, logging out disposes the page's client and navigates nowhere, and the opener's refresh still answers 200. Mutation: send it through `/auth/logout`, and the opener's refresh answers 401.
- **A plain member of the dev Star opens a persona's tab.** `persona-host`'s limb 2 moves P from refused to admitted, and `handleRefreshToken`'s JSDoc and `website/docs/nebula/auth-flows.md` § *A persona's page* stop saying only an admin opens one. Mutation: restore `if (!persona)`, and P is refused.
- **A tab loads only when it first comes into view.** Opening Studio with a cast of three opens one socket to the dev Star, for the tab in view, and a build afterwards reloads that one frame. Mutation: load every frame when the strip renders, and the dev Star holds four sockets.
- **A persona opens on its own host, outside Studio.** A browser with no cookie opens Mary's host, logs in through the scaffold's redirect, lands back as Mary, and reads `mary ·` at the start of the title. Mutation: drop the persona kind from `checkedReturnTo`, and the login returns nowhere.
- **A slug the shared predicate refuses stops the run before anything is created**: uppercase, `.`, `~`, `@`, a leading or trailing hyphen, `--`, under 3 or over 30 characters. Mutation: drop the check, and a grant lands on a persona whose host never parses.
- **A procedure naming an unknown node is refused before anything runs.** Mutation: drop the check, and a grant lands on nothing.
- **`grant` carries a DAG tier and nothing else.** Mutation: let a grant carry `scopeAdmin`, and every persona granted anything bypasses the org tree.
- **The cast guidance teaches the procedure as built**: `node`, `edge`, `grant` and the data verb, with `mint` gone from both homes and from `scaffold-seed-drift.test.ts`'s verb loop; a slug and a name per persona; the admin persona marked on the persona, not bundled into a grant; local `ref`s; asking in chat before provisioning, since every run wipes; and how much data to seed. Neither home may say a persona has an address, that its id changes on a wipe, or that a slug's limit is anything but the shared predicate's; `grep -nE 're-mint|composed at provision|@example|11 char'` over both finds nothing, and the skill's reason for the 3-character floor becomes punycode's `--`. Mutation: skip the regenerate, and `gen-scaffold.mjs --check` or `gen-platform.mjs --check` reds before vitest runs, which the drift tests alone would not.
- **No symbol names the procedure a plan.** Checked by reading the exported names over the changed files.
- **The harness accepts with a nickname, as the consent screen does,** because ADR-009 has the harness follow the real path and no real accept lacks one. The same `acceptMembership` change is what the backlog's consent-modal prefill row needs (§ *Nebula Auth*), so the build marks that row's helper half delivered. It changes a shared login helper, so `drive.ts all` follows.
- **One ADR-016 record per provisioning run names the poster,** written on the Galaxy before the hand-off. Mutation: drop it, and a run's wipe and grants record no one.

## Review progress

Recorded as it happens, so a later session can pick up where this one stopped.

- **2026-10-09, the rewrite.** Everything below § *Design intent* was rewritten against the day's decisions; § *Context*, § *Objective and goals* and § *Design intent* stand as Larry reviewed them. A self-review fixed three claims before the panel ran: a host string, the ontology pull on a wiped Star, and a stale premise about Austen.
- **2026-10-09, `/review-task` Stage 1 launched** on this phase-less file, as workflow run `wf_1a10fb7d-2f3`. Its synthesis lands below when it returns. If it never does, re-run Stage 1 from scratch: a workflow's cached results do not cross sessions.
- **2026-10-09, Stage 1 returned** (run `wf_1a10fb7d-2f3`): 48 findings raised and 48 survived verification across all four lenses, none erroring, so the reviewers checked against source and the list is worth working item by item. It is pasted below as the queue for the gate. Resolve one item per turn with Larry (`workflow.md` § *Teeing up decisions for Larry*), delete each as it lands, and re-scout before Stage 2. The structural recommendations S1–S7 come first; S1 (auth.md and ADR-015 amended before Stage 2) and finding 2 (how `provision`'s outcome returns to the turn, under ADR-003) are Larry's.
- **2026-10-09, gate item 1 resolved (Larry): the cast record lives in Galaxy storage** (§ *Decisions*). It settles S3, findings 5 and 16, and the old open question on the `.nebula/` run record. ADR-022 § *A persona's host* now says the refresh asks the Star for the mark; it asks the Galaxy, which joins the ADR edits at gate item 8.
- **Gate order, re-evaluated after each answer:** 2, what a re-run does and what re-provisions after a wipe (Larry: re-provisioning is the model calling `provision` again, never a replay); 3, how provisioning's result returns to the turn under ADR-003; 4, Studio's invite screen; 5, the default open tabs; 6, goal 4 at the `.dev` tier; 7, Larry's sections; 8, the auth.md, ADR-015 and ADR-022 amendments. The findings that are the author's own are applied after the gate, against the final design.
- **2026-10-09, gate item 2a resolved (Larry): every provisioning run starts by wiping the dev Star, once the asker confirms** (§ *Decisions*). It settles finding 4 and deletes the empty-node rule. S4 is adopted as the author's: the hand-off carries the Galaxy's applied ontology row, which settles finding 3.
- **2026-10-09, gate item 3 resolved (Larry): the confirmation is a chat exchange.** The model asks, its turn ends, and the person's answer starts the turn that calls `provision`; the outcome lands as a Nebula message. It settles finding 2 with no exception to ADR-003, and later a chip and an LLM discriminator after every post replace the bare message.
- **2026-10-09, gate item 4 resolved (Larry): every wipe of the dev Star goes through `provision`, and Studio's Wipe button goes.** It settles finding 10 and S6. Larry also asked that a post arriving during a turn be held for the next turn rather than skipped; the author placed that here, since the chat confirmation depends on it, and fast-follow Item 6 keeps the rest.
- **2026-10-09, gate item 5 resolved (Larry): the agent invites, after a chat yes, under the poster's own claims; no invite screen.** It retires the 2026-09-04 rule keeping loop tools at the chat floor, on Larry's principle that traceability and reversibility pay for more agency. The `invite` tool is in this task, since goal 4 depends on it and it is small.
- **2026-10-09, gate item 6 resolved (Larry): every persona opens by default, as a trial, and a tab first loads when it comes into view**, with the fallbacks recorded in § *Future state*. Larry also asked for `calibration.md` §15, on reaching for least agency; it is added.
- **Gate order, re-evaluated:** next, goal 4 at the `.dev` tier; Larry's sections; and the auth.md, ADR-015 and ADR-022 amendments.
- **2026-10-09, gate item 7 resolved (Larry): goal 4 now says an Austen cannot invite anyone into the Galaxy, and may do whatever she wants in the dev Star.** Settles finding 22.
- **2026-10-10, gate item 8 resolved (Larry): wrong turn 1 retitled and its reason fixed; the cast paragraph moved to the end of § *Context* with a roadmap sentence; "the chat floor" defined at its first use.** Settles findings 14 and 24.
- **2026-10-10, gate item 9 resolved (Larry): auth.md, ADR-015 and ADR-022 amended in place, uncommitted, for Larry's review.** Settles S1 and finding 1, the review's one blocker. The gate is complete.
- **2026-10-10, the author's findings applied** while Larry reviewed the doc amendments: S2(c) and (e), S5, S7, and findings 6, 7, 8, 9, 11, 12, 13, 15, 17, 18, 19, 20, 23, 25, 27, 28 and 29. A self-review also removed a stale reference to convergence from the cast-record row.
- **2026-10-10, Stage 1 re-run launched** as workflow run `wf_64e0eb4a-0c1`, after a self-review fixed two more claims. Its synthesis lands below when it returns; if it never does, re-run Stage 1 from scratch.
- **Next (done above for the findings):** apply the author's own findings against the decided design, re-scout, then re-run Stage 1, since the gate reshaped the file (the cast record, the forced wipe, the chat confirmation, the agent's invite, the hold); Stage 2 follows a clean Stage 1. Before the gate began, two findings were applied: finding 20's closed `[x]` backlog row is deleted, and finding 13's stale line in `nebula-pre-alpha.md` decision 1 now gives the opener rule.
- **2026-10-10, the Stage 1 re-run returned** (run `wf_1a10fb7d-2f3`'s script, run `wf_64e0eb4a-0c1`): 57 raised, 56 survived, all four lenses ran. Two blockers: a held post's turn runs under the previous poster's claims (B1), and no product path applies an ontology, so the hand-off carries `null` (B2). The first pass's queue is replaced by this one; git keeps it.
- **2026-10-10, re-run item 1 resolved (Larry): the agent posts to the chat as itself, and a turn the agent starts only talks** (§ *Decisions*). It settles B1, and the outcome-Message half of M1: provisioning's outcome is the agent's own post. `docs/vision/auth.md` § *When the agent acts* is amended, uncommitted, for Larry's review.
- **2026-10-10, re-run item 2 resolved (Larry): every build whose ontology compiles applies it, and `applyOntology` goes** (§ *Decisions*). It settles B2. ⑤ gets a line saying its append moved to the build. Larry also chose Cloudflare's Clef over Jev for the discriminator, recorded in fast-follow Item 6.
- **2026-10-10, re-run item 3 resolved (Larry): the Galaxy's chain carries no `sub`, and the dev Star builds the tree and grants as the setup identity `_setup`, displayed as "Setup"** (§ *Decisions*). It settles M1. `requireDominionHere` reads the claims passage derives, so the chain passes the provisioning entry's door with nothing written into `originAuth`.
- **2026-10-10, re-run item 4 resolved (Larry): `asPersona(node, slug, { admin }, fn)`, exported from `@lumenize/mesh/auth`** (§ *Decisions*). It settles M2. Larry asked that nothing open a path to a Star with real users; the row *Nothing here reaches a Star with real users* states the five facts that hold it, and four criteria check them.
- **2026-10-10, re-run item 5 resolved (Larry): the agent invites both kinds of collaborator, by two paths; Austen is refused further down, and the chat-floor assertion stays** (§ *Decisions*). It settles M3 and M4, and the gate is complete.
- **2026-10-10, the author's findings applied:** M5 and the minors and nits, m11 under the go-ahead rule Larry had already decided. Larry's sections took four edits he approved in advance: goals 1 and 2 rewritten (M5), one clause scoping the risk test (n3), wrong turn 2's citation (m9), and a sentence cut from § *Context* (n4).
- **2026-10-10, a third Stage 1 launched** as workflow run `wf_5dee1eea-563`, focused on what the gate changed, because the gate redesigned several mechanisms (`/review-task` § *Gate*). If it never returns, re-run Stage 1 from scratch: a workflow's cached results do not cross sessions.
- **2026-10-10, the third Stage 1 returned** (run `wf_5dee1eea-563`): 51 raised, 50 survived, all four lenses ran, no blocker. Its four structural items reopen the gate: split the gate's two redesigns into sibling tasks (S1); on apply-on-build, keep tenants off unpublished rows (S2); pin the dev Star's provisioning door to its own Galaxy's chain (S3); and decide how the agent's own turn reads the thread (S4). The author verified the main premises against disk: deleting `wipeOnInstall` removes the only fence keeping a breaking row off a tenant, the facet key `${galaxyId}/${version}` is shared by every Star in a Galaxy, and `#historyBundle` returns `{}` without claims. The second pass's queue is replaced by this one; git keeps it.
- **2026-10-10, third-pass items 1 and 3 resolved (Larry).** S1: the gate's two redesigns split into sibling tasks, apply-on-build first, then the agent's voice in chat, and personas depends on both; S2, S4 and M5 move with them. S3: a `.dev` Star's own behavior is a capability composed per instance behind `get dev()`, whose guard admits only the Star's own Galaxy's chain; it settles M1's door and M4. The remaining findings are the author's, applied once the siblings land, since several will move with them.

### Stage 1 third-pass findings, 2026-10-10

The four lenses (spec-hygiene, scope-discipline, prose-voice, product-vision) returned 50 verified findings, which collapse into 22 items here. No verdict reached blocker. One finding was downgraded from blocker to major.

#### Structural recommendations (lead)

**S1. Split out the two redesigns the 10-10 gate brought in, or at least put them in the framing.**
- **The two changes:**
  - The agent now posts as subject `agent:lumenize`, and there is a new tool-less turn when a turn ends.
  - Every build that compiles now appends its ontology, which deletes `applyOntology`, `wipeOnInstall` and `resetDevData`.
- **Where they show up:** both reach well beyond personas, yet neither appears in § *Context*, § *Objective and goals* or § *Design intent*. They surface only in § *Current state*, Missing 11–12 and § *Decisions*.
- **What depends on them:** M2, M3, M5, most of M6, the build-path half of M1, and minors 1, 4 and 5.
- **Recommended:** move both into a sibling task this one depends on, one child file at a time. Do apply-on-build first, because provisioning's hand-off reads its row.
- **Fallback:** give each change a goal and a § *Design intent* bullet. Those are Larry's sections, so propose the text.

**S2. Re-tee apply-on-build with Larry, on corrected premises (M2).**
- Every premise the row rests on is false against disk.
- **Recommended option (a):** the dev Star follows every build, and `getCurrentOntology` answers a non-`.dev` Star nothing until fast-follow Item 4 supplies a released-version source.
  - Before alpha, `#serveBuiltApp` already answers 404 for every tenant, so a user sees no difference.
  - It makes "a build reaches a tenant" structurally impossible instead of guarded (calibration §2).
- **Option (b):** apply everywhere. Record the tenant exposure as accepted in the "Nothing here reaches…" row, and amend Item 4 to restore a fence before any tenant is served.
- **Option (c):** keep a build-computed `breaking` bit that fences installs off `.dev`.

**S3. Pin the dev Star's provisioning door to its own Galaxy's chain, and have the Star pull its row itself.** This covers M1 and M4.
- **The guard:** admit only a call with no `originAuth` whose `callChain[0]` is this Star's Galaxy. That is sound for the same reason `claimsForPassage` is: a Client's chain always carries claims.
- **The argument:** pass the entry a version only. The Star pulls the row itself.
- **What it closes:** M1's door path.
- **What it deletes:** M4's Mesh change. There is no `requireDominionHere` widening, no `claimsForPassage` callee parameter, and no negative control for the alarm chain.
- **It does not reopen Larry's 10-10 acceptance.** That acceptance covered actions inside the dev Star. This path leaves the dev Star through the shared validator cache.
- **Knock-on:** the new end-of-turn chain is also Galaxy-started with no `originAuth`. Its "offered no tool" limb is then what keeps it off this door. Restate fact (3) as that property of the door.

**S4. Decide or defer how the turn that starts when a turn ends reads the thread, before phases are written (M3).**
- As specified, that turn cannot read the thread it is meant to answer.
- Any fix is Larry's call. A server-internal read would be the first agent turn that reads with nobody's permissions, against strategy check 1 and the ADR-019 withdrawal ("every read rides the asking human's token").
- If S1 splits the change out, this decision travels with it.

#### Major

**M1. Any `.dev` admin can install a validator that tenant Stars then run.** (spec-hygiene, scope-discipline, product-vision)

Location:
- Missing 2
- § *The order provisioning runs in*, step 1
- § *Decisions* rows "Nothing here reaches a Star with real users" (fact (3)) and "The Galaxy's chain carries no `sub`"
- Criterion "Only a Galaxy collaborator reaches provisioning"
- § *Design intent*, "Provisioning… sits at the chat floor"

Finding:
- **The door is too wide.** It is `requireDominionHere`, which admits Austen, Mary's tab (and the generated code running in it), and anyone invited straight into `.dev` with the bit.
- **The entry trusts what it is handed.** It installs a caller-handed `OntologyVersionRow`, executable `validatorBundle` included. Nothing ties the bundle to `version`, which is a `hashBlob` of `types`, so the next label is predictable.
- **The facet key is shared.** `star.ts` keys the facet `${galaxyId}/${version}`, the same key for every Star in the Galaxy. The Worker Loader caches by that key across the project, and the first cached entry wins. Tenant Stars then validate with the forged module and store its output (`parseBatch`).
- mesh.md keeps `onOntologyPulled` off `@mesh()` to close exactly this.
- **The build path has the same hole, and no door fix closes it.** Once every build appends (M2), the job runs the user's own `vite.config.ts` after the compile writes `ROW_PATH`, and the Galaxy checks only `row.version`. Any chat-floor collaborator can forge the registry row that tenants pull.
- **Fact (3) argues the wrong thing.** It reasons from who starts the chain, not from who passes the door.
- **A direct call skips the Galaxy.** It bypasses the chat floor, the ADR-016 record and the cast-record rewrite. So the "only a Galaxy collaborator" criterion and the Design intent sentence are both false.

Suggestion:
- Use S3 for the door. Use S2(a) for the build path, or have the Galaxy derive or verify the bundle instead of trusting the container's.
- S2(a) alone still leaves the shared key. When Item 4 later releases a version, a tenant loads a key a `.dev` load may already have cached with a forged bundle. Give `.dev` its own `bundleId`, or key the facet on the bundle's own hash.
- Restate fact (3) as a property of the door.
- Add a criterion: Austen's direct call with a forged row is refused, with the message matched. Mutation: gate the entry on `requireDominionHere`, and her call wipes the Star and installs her row.
- If the door stays on dominion, state in the row that any `.dev` admin may call it directly, and that a direct call leaves the cast record stale.

**M2. Apply-on-build's premises are false, and the tenant fence goes with `wipeOnInstall`.** (spec-hygiene, scope-discipline ×2, prose-voice, product-vision)

Location:
- § *Decisions* row "Every build whose ontology compiles applies it"
- § *Relationships*, ⑤ bullet
- § *Constraints*, codegen-loop header bullet
- define-ontology step 6
- fast-follow Item 4

Finding:
- **The fence claim is false.** The row says a breaking version "installs nothing" off `.dev`. The only fence is D23: `#install` sets `wipes = Boolean(installed && row.wipeOnInstall)`, and `#wipe` throws off `.dev`. This task deletes `wipeOnInstall`, so every compiled row installs on any tenant that pulls it.
- **"Nothing is published" protects nothing.** `getCurrentOntology` is a bare `@mesh()` and serves the latest applied row, published or not.
- **"Held back only for the wipe bit" is false.** `#buildAndAnnounce`'s JSDoc and the codegen-loop header call the held-back append the D2 line: an autonomous tool can build but never install. The build append ends that line, not `provision`.
- **What actually holds today:** only `#serveBuiltApp`'s 404 off `.dev`. Item 4's demand trigger reopens it.
- **Item 4 goes stale.** Its "D23 fences it" sentence becomes false, and this task does not amend it.
- **A backlog trigger has tripped.** The row "Studio: breaking-ontology-change → deterministic Reset-data/Revert prompt" says "never via the LLM". After this task, step 6's model judgment is the only breaking-change detection on `.dev`, and the task file cites neither.

Suggestion:
- Apply S2.
- Rewrite both premise sentences on the true reason.
- Add the ontology row as a sixth path in "Nothing here reaches…", and amend Item 4 in the same edit.
- Move the codegen-loop header edit to the phase that lands the build append.
- Record that backlog row as the target that removes the LLM-only interim. Do not weaken its "never via the LLM" clause.

**M3. The turn that starts when a turn ends cannot be built as specified.** (spec-hygiene, scope-discipline, prose-voice, product-vision ×3)

Location:
- § *Decisions* rows "A turn a person's post starts acts as that person" and "The agent posts to the chat as itself"
- Missing 11
- § *The order provisioning runs in*, step 4
- The invite row's outcome handler
- Criterion "A post that arrives during a turn gets a reply when the turn ends"
- auth.md § *When Nebula is the actor*

Finding:
- **Read:** the turn runs outside any call context yet "reads the thread".
  - `#historyBundle` returns `{}` when there are no claims.
  - `Snapshots.read` calls `requirePermission`, which throws 'Authentication required' when there is no `sub`.
  - With no context at all, `callContext` itself throws.
  - The turn replies blind, and the criterion still passes.
- **Start:** `runTriggeredTurn`'s `finally` runs inside the poster's AsyncLocalStorage context, and `runWithCallContext` is not public. The real way out is an alarm or a `newChain` self-call, and the file names neither. A builder who can't get out will run the turn as the poster, which is B1's borrowing again.
- **`replyTo`:** `commitAgentMessage` requires a single `replyTo`. App.vue's `replyLanded` and the stream re-arm both key on `replyTo === lastPostedId`. One combined reply settles at most one poster, and the others stay on 'failed' or wait forever (calibration §12, §13).
  - Provisioning's outcome and the admin-kind invite outcome have the same gap.
  - Which posts count as "posted during it" is undefined.
- **Write:** dropping `pinnedAtPost` removes the Step 8 skip. The file must say that a server-supplied subject skips Step 8.
- **The backstop is false.** "A tool given to it by mistake finds no `sub`" does not hold. `readSource`, `writeSource` and `buildNow` run in-process past the decorator and check no claims, so a `write_file` would commit source under nobody's claims.
- **The criterion is unobservable.** "Offered no tool" has nothing to read, because `codegen` records `toolCalls`, not the tools offered.

Suggestion:
- Apply S4, then pin each of these in the row:
  - **The read authority:** a server-internal read of the chat node, justified because the reply reaches only its readers, or a read as each waiting poster.
  - **The start:** for example a fresh-chain `svc.alarms.schedule(0, …)`.
  - **The post set:** human Messages committed after the triggering post and before the ending turn's reply.
  - **`replyTo`:** one reply per waiting post, each streaming against its post. Outcome messages carry the confirming post's id through the continuation.
- Record the offered tool set on `codegen`.
- Drop the "by mistake" clause.
- Add limbs:
  - The reply carries Austen's post. Mutation: keep `#historyBundle`'s no-claims early return.
  - Two posts during one turn both settle in their posters' Studios.
  - Mutation: assemble the turn with the loop's tools, and the recorded tool set names them.

**M4. `requireDominionHere` reads only `originAuth`, so the hand-off is refused as the code stands.** (all four lenses)

Location:
- Missing 4, the line after the code block
- § *Decisions* row "The Galaxy's chain carries no `sub`"
- § *Constraints* JSDoc list
- § *Review progress*, re-run item 3
- The ADR-015 amendment ("One function derives the pair")

Finding:
- **The sentence contradicts itself.** "Reads `originAuth` directly, so it reads these derived claims too" cannot be true. `claimsForPassage` is module-private, feeds only the passage step and `[GATEWAY_PASSAGE]`, and its JSDoc says nothing is written into `originAuth`. So a Galaxy-started chain throws 'Admin access required'.
- **Unlisted Mesh changes:**
  - The guard must read the derived claims. That touches every `@mesh(requireDominionHere)` site, such as `setGalaxyConfig`, for chains a node starts.
  - `claimsForPassage` must see the callee. `CallContext.callee?` may already serve.
- **The realized-tree read also fails.** "Returns the realized tree" hits `OrgTree.getState()`'s `#requireAuth()`, which throws when there is no `sub`.
- **ADR-015 overstates today's code.** "One function derives the pair" is not true yet: two readers derive claims separately.

Suggestion:
- Prefer S3, which deletes all of this.
- Otherwise:
  - Add a Missing item for both Mesh changes.
  - Add a negative control: a Star's own alarm chain is still refused.
  - Add a mutation: revert the guard to read `originAuth`, and the call fails with 'Admin access required'.
  - Run the realized-tree read inside the `_setup` block.
  - Fix re-run item 3.

**M5. Posting the agent as subject strands the `actor` record and changes the byline, and the file says neither.** (spec-hygiene, prose-voice, product-vision)

Location:
- § *Current state*, "The agent's reply"
- § *Decisions* row "The agent posts to the chat as itself"
- § *Constraints*
- auth.md § *When Nebula is the actor* (accepted)

Finding:
- **The `actor` option loses its only caller.** `commitAgentMessage` (galaxy.ts:1693) is the only production caller of `ensureResource`'s and `TransactionOpts`' `actor`. After the change, no write carries `act: agent:lumenize`:
  - `writeSource` logs only the poster's claims.
  - `_InviteStatus` rows go through `doTransaction`, which takes no `actor`.
  - Seeds run as personas.
- **So two claims describe nothing built:** "this human, via Nebula" and auth.md's "the platform adds itself as an actor".
- **The byline changes.** "Lumenize for Jennifer" with two avatars becomes "Lumenize" alone, and nothing says whose request it answered.
- **Consumers the edit list misses:**
  - `deriveParticipants`
  - App.vue's byline and avatar stack
  - `first-app-built` limb 4
  - `four-party-chat`, which asserts `sub` is Austen and `act.sub` is `NEBULA_SUB`
  - `child3-post.test.ts:203-207`

Suggestion:
- Decide whether any agent write keeps the actor, such as the admin invite's rows or Item 6's sub-agent. If none does, delete `actor` along with `pinnedAtPost`.
- Narrow auth.md to what is true: writes carry the poster's claims, and the reply's `codegen.toolCalls` plus its `replyTo` record what the agent did and for whom.
- State the byline after the change. Recommended: "Lumenize, re: {poster of `replyTo`}", with a criterion for it.
- List the five consumers, and mark the `four-party-chat` assertions as inverted (calibration §3(b)).

**M6. The Coverage map predates the gate.** (scope-discipline, prose-voice, product-vision)

Location: § *Criteria*, Coverage paragraph; § *Current state*, "Three ways to wipe the dev Star".

Finding:
- **Only three scenarios are named:** `personas-provisioned`, `persona-tabs`, and `studio-guidance-loop`, which does not gate.
- **Criteria with no scenario:**
  - The reply to posts made during a turn
  - `deriveKind`
  - Both invite paths and their refusals
  - P's `.dev` promotion
  - The persona logout
  - The phone login on a persona's own host
  - Lazy tab loading
- **The fix for Stage 1 blocker B1 has no gating witness.** Criteria that need a model turn would land on the one limb that never gates (calibration §9).
- **Touched scenarios that are not named:**
  - `four-party-chat` (gating, with a real model turn, and asserting the old attribution)
  - `grant-reveals-denied`, `node-invite-roundtrip` and `star-serves-current-ontology` (they call `applyOntology`)
  - `downward-dominion` and `studio-codegen-rest` (they drive `resetDevData` through the `wipe` helper)
- live.md requires the deployed pass to cover every scenario the build writes or touches.

Suggestion:
- Map each criterion to a scenario and say whether it gates.
- Drive the deterministic halves without the model: refusals by message, the promotion, the logout, and the timing of a post made during a turn. A gating real-model scenario such as `four-party-chat` can carry the rest.
- Name every touched scenario and say what moves to `provision`.

**M7. The `_setup` criterion has no record to read.** (spec-hygiene, scope-discipline, product-vision)

Location: criterion "The tree and grants are written as the setup identity"; § *Decisions* row "…displayed as 'Setup'"; § *The order provisioning runs in*, step 2.

Finding:
- **No writer is recorded.** `Nodes`, `Edges` and `Permissions` store no writer. Only Snapshots records an actingToken, and `_setup` writes no Resources.
- **"Setup" is never written.** No step writes that name, so `_setup`'s Profile is never-written, and Item 13's list leaves it out. No surface shows it either.
- **The fix the criterion implies is ruled out.** It would need a stored-shape change, which § *Relationships* says this task makes none of.

Suggestion:
- Assert where `_setup` actually acts: a tree write outside the block throws 'Authentication required'. Mutation: drop the `asPersona(this, '_setup', …)` wrap, and the first `node` step fails.
- Keep the `parseHost` and cast-refusal halves.
- Drop "displayed as 'Setup'", or name both the write that sets it and the surface that shows it.

#### Minor

1. **Gate the append on the bundle.** (spec-hygiene, scope-discipline, product-vision)
   - Location: the apply-on-build row ("the version the preview's bundle was built against"); § *Current state*, "The build's ontology step"; § *The order provisioning runs in*, step 1.
   - Finding:
     - **A failed bundle still advances the version.** No build step gates another, and `--emptyOutDir=false` keeps the old `dist`. If the ontology compiles but the bundle fails, v2 is appended while the served page is still v1's code, stamped as v2.
     - **A revert moves the current row without an append.** `#appliedHead` reads the file first, so reverting `src/ontology.d.ts` makes an older row current with nothing appended.
   - Suggestion:
     - Append only when `bundle.ok && #distArrived(indexSha256)`. Do not key on `preview.refreshed`: a withheld preview still serves its new `dist`.
     - Add a limb: a failed-bundle build appends nothing.
     - In step 1, write "the Galaxy's current row (`#appliedHead`)".

2. **The invite tool and the other new entries are unnamed.** (all four lenses)
   - Location: § *Current state*, "The loop's tool table"; Missing 7–9; the invite row.
   - Finding:
     - **The chat-floor claim needs a new entry.** `LoopEntry` is a union of Galaxy method names. `resources` is in the bare tier, and `AuthFacade.invite` is not a Galaxy method. So "every Galaxy method a tool names sits at the chat floor" needs a new `@mesh(requireChatWrite)` Galaxy `invite` entry, which any chat member could also call over the wire.
     - **Also unnamed:** the entry Studio reads the cast record through, with its tier, and the two result handlers (provisioning outcome and admin-kind invite outcome).
     - **The admin-kind refusal arrives late.** It reaches the Galaxy handler after Austen's turn has already replied. "Puts her request to a Galaxy admin" can therefore only be that handler's post.
   - Suggestion:
     - Name the entry, and say whether a direct call is intended.
     - Give the new exact chat set (`buildNow`, `invite`, `provision`, `readSource`, `writeSource`) and the bare set.
     - Give the handler a fixed message for a refusal that asks a Galaxy admin, citing the "Nebula as permission broker in chat" backlog row.
     - Add no in-turn dominion pre-check (calibration §2).

3. **Some mutations cannot fail.** (spec-hygiene, scope-discipline, prose-voice, product-vision)
   - Location: criteria "Provisioning twice leaves the same cast", "Persona claims built on `acme.crm.dev` always carry `aud` `acme.crm.dev`", and the two invite criteria.
   - Finding:
     - **Provisioning twice:** with the wipe skipped, run 2 throws at `checkSlugUniqueness` and the count stays green.
     - **The `aud` criterion:** "take the Star as an argument" is a signature change, which no test written against `asPersona(node, slug, { admin }, fn)` can see.
     - **Duplicate invite criteria:** both carry the same "restore `memberHere`" mutation.
   - Suggestion:
     - Assert that run 2 succeeds and that every Deal's id differs from run 1's.
     - For `aud`, use a body mutation that doesn't duplicate line 250's Galaxy-scope mutation (for example a stale or hard-coded Star), or merge the two limbs.
     - Merge the two invite criteria.

4. **The deletion grep matches code that stays.** (scope-discipline, prose-voice, product-vision)
   - Location: criterion "Provisioning is the only path that wipes the dev Star"; § *Current state*, "Three ways to wipe".
   - Finding:
     - **False matches:** bare `applyOntology` matches `StarTest.applyOntologyForTest` (9 files, which Item 4 keeps), the gitignored studio-ui `dist`, and JSDoc such as `RESERVED_STAR_SLUGS` at types.ts:321. That JSDoc is also missing from the list.
     - **No mutation** is stated for the criterion.
     - **The counts are wrong:** 3 tests pass the flag, and only 4 files call `applyOntology`.
   - Suggestion:
     - Use `git grep -nwE` over structure: no `applyOntology` member or call, no `wipeOnInstall` field or env key, and no `resetDevData` member.
     - Decide whether `applyOntologyForTest` is renamed or exempted.
     - Run the instrument now, and fix the counts.

5. **The standing-guidance inventory misses model-facing docs and rules.** (prose-voice)
   - Location: § *Constraints*, "Standing guidance this task changes".
   - Finding:
     - **Model-facing docs teach a dead Apply.** api-reference.md:72 and :96, nebula-client.md:22 and using-vue.md:44 say `ontologyVersion` is absent "until an Apply has run". They are copied into `.platform/docs`, so Studio's model would teach a step that no longer exists.
     - **Rules and an ADR:** mesh.md § *A gate the RESPONSE leg reaches* and § *A gate is a GETTER*, and ADR-016 § *In scope today*.
     - **JSDoc:** `Resources.wipe`, `Resources.#install`, `generationDeadlineMs` and `get resources`.
   - Suggestion:
     - Add all of these, and regenerate the embedded `.platform/docs` copies.
     - Replace the hand-kept list with a grep the phase runs: `-rnwE 'applyOntology|wipeOnInstall|resetDevData|pinnedAtPost|Apply'` over apps, packages, website/docs, .claude and docs. Each hit is changed or kept on purpose.

6. **Future state's "one place that changes" is false again.** (spec-hygiene, scope-discipline)
   - Location: § *Future state*, second bullet.
   - Finding: after the 10-10 split, a `test` Star also needs the hand-off rule, `Resources.#wipe` and the co-mint. All three key on the workspace constant. m1 is recorded as applied, but the bullet came back.
   - Suggestion: name all three sites, or give such a Star a path of its own.

7. **Sibling amendments contradict this file.** (prose-voice, scope-discipline)
   - Location: auth.md § *Grants* and § *When Nebula is the actor*; § *Relationships*, line 40; fact (1).
   - Finding:
     - **§ *Grants*** still says a `sub` exists only once a membership does. Persona subs have none.
     - **"Written as the cast"** contradicts the tree being written as `_setup`.
     - **Fact (1)'s "exactly the claims the persona refresh mints"** is false for `_setup`, and false when the caller passes the admin bit.
     - **Line 40's list is incomplete.** It omits three amended auth.md sections and ADR-022's Workers KV bullet, and it misdates the ADR-022 change.
   - Suggestion:
     - Add the persona exception to the § *Grants* ordering sentence.
     - Write "written as the setup identity, then as each persona".
     - Reword fact (1) to the `.dev` `aud` and `authScope` plus a `sub` from `personaId`.
     - In line 40, list every amended section, or point at the files with no section list.

8. **Cast-record changes do not reach an open Studio.** (scope-discipline)
   - Location: § *Decisions* row "The cast record lives in Galaxy storage".
   - Finding: the record lives in Galaxy KV, so a one-shot read leaves the strip stale after a re-provision.
   - Suggestion: Studio re-reads the record when the provisioning outcome Message arrives, which it already subscribes to. Add a `persona-tabs` limb: provision with a changed cast, and the strip changes without a reload.

9. **Names drift.** (prose-voice)
   - Finding:
     - "The provisioning entry" names two different methods.
     - The agent is called "Nebula", "the agent", `agent:lumenize` and "Lumenize".
     - "The persona function" survives beside `asPersona`.
     - "Catch-up" is an undefined noun, already copied into fast-follow Item 6.
     - "Reaches" in rows 211 and 222 is the sense ADR-015 § *Terminology* retired.
     - "Subject, grant and scope core" names no symbol.
   - Suggestion:
     - Give each thing one name: "the Galaxy's `provision` entry" and "the dev Star's provisioning entry"; `asPersona`; "the agent (`agent:lumenize`, shown as Lumenize)".
     - Ask Larry before coining "catch-up".
     - Restate row 222's headline in terms of passage and dominion.

10. **`edge` has no example.** (prose-voice)
    - Location: § *The procedure, by example*; step 2; the cast-guidance criterion.
    - Finding: the example's `node` with `parent` already creates the first edge, and the shipped template defines `edge` as the same thing. Nobody can tell what an `edge` step adds or what fields it takes.
    - Suggestion: add one literal `edge` step for a second parent, with one sentence saying `parent` is the first edge and `edge` adds another. Or drop `edge`.

#### Nit

1. § *Constraints*, line 176: `asPersona` doesn't "meet" security.md's no-synthetic-`aud` rule; it is the rule's one named exception. Reword.
2. Row 205's "What it removes" sentence credits the risk test with removals that have their own rows and reasons, and contradicts § *Design intent*. Cut it.
3. tasks/nebula-pre-alpha.md row ② and § *② Personas* say every question was decided on 10-09 and that Stage 1 is next. Point at this file instead of restating dates.
4. A phone that opens the persona's own-host link holds a 30-day refresh cookie, and that page's logout ends no session. Add one clause: the phone signs out from Home on the platform host.

#### Biggest risks

- **A forged validator can reach tenants quietly.** A caller-chosen `validatorBundle` can arrive through the dev Star's door or the build's `ROW_PATH`. It lands under a version-keyed, project-wide cache that tenants share, and this task deletes the only tenant fence (D23). Today only a 404 holds; S2(a) plus S3 make the protection structural.
- **Two designs will not build as written:** the turn that starts when a turn ends, and the dominion hand-off. Each has a green-staying criterion and a tempting fallback that brings the bug back: borrowing the poster's context, or writing synthetic claims into `originAuth`.
- **The gate's changes have no coverage.** They have no gating scenario, and the existing scenarios they break, `four-party-chat` among them, are not named.
