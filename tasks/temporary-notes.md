Is claim* always for self-signup and create* always for system/admin use?

> **Consent flag**  `improveProductConsent = 1` (`registry:319`)  omitted → NULL (`registry:400`)  **OMIT — leave NULL, mirror `createStar`.** The flag is **Universe-only** (`schemas.ts:25`: *"unset on non-Universe scopes"*), and `listConsentedInstances` (`registry:281-284`) selects `WHERE improveProductConsent = 1` with **no tier filter** — so a copied `=1` silently enrolls the tenant's Star in the product-improvement corpus though they never opted in, honored the moment a consumer is built.

Why not set it to 1 (aka `true`) for self-signup Stars? We want it to be opt-out until we get push back. Who says it's Universe-only? If it were Universe-only, then I would have pushed harder to switch this to its own sparse table. The flag still makes sense at different levels. At the Universe level, we can use every AI development session to improve our system prompt content. At the Star level, it gives the Galaxy admins permission to use the Star's data to improve their products.

Also, I know that in SQLite there is no actual boolean type and the column is integer under the covers, but what is recommended best practice? Should we declare columns like this as boolean and send in `true` or `false` because it's better documenting? Or does that cause problems because it'll come out at 1 or 0 so it's better to just admit that up front?



> **Reserved-slug list**  `PLATFORM_INSTANCE_NAME`  (n/a)  **`dev` + the collapse's env names** (§Slug), a different list.

What does "collapse's env names" mean? What does PLATFORM_INSTANCE_NAME mean? Maybe we should flip this row so it describes allowed slugs. That let's you say `dev` for column that is now n/a and specify that the slug must already be unclaimed for the last column.



We might want to define "founder". Is it just the first admin for the scope? Or is it also the first admin in the root node of the orgTree? The latter only applies to a Star for now at least.



> **Why an ordinary login cannot serve instead — LOGIN NEVER MINTS.** Identity mint is authority-point-only (the registry says outright *"NEVER call from a login path"*). A magic link for a scope with no identity is **issued and emailed**, then rejected on consumption: `consumeMagicLink` → `getAndVerifyIdentity` → null → `302 /app?error=invalid_token`, **no cookie** (the `'Magic link for non-member'` warn in `login` — [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)). So a Star with a `Scopes` row and no founder is not "log in and it works" — it is a scope nobody can ever enter. `claim-universe` is the **only** open founder-minting entry today. This is what makes Phase 2 non-optional rather than a convenience. (Documented at [email-login.ts:252-267](../apps/nebula/test/lib/email-login.ts).)

"instead" of what? I basically understand what you are talking about here, but unlike an LLM, I'm not going to read the code for the `claim-universe`'s' machinery. We say that we are going to "reuse" that but when I hear "reuse" I generally think "call it, maybe with parameters". Is that what we mean here or do we mean "copy as a starting point"? Or maybe we mean, "call the parts of claim-universe that we can use verbatim and substitute where it deviates? So, at least for me as the human reviewer, we need to explain what the mechanism _is_  before we talk about what it _is not_. Maybe this calls for a step-by-step of the happy path and/or a sequence diagram if there are multiple participants. 

Also, we may eventually want to allow already authenticated users to create Stars. Does the mechanism you have in mind allow for that?