# Does a Worker Preview's SELF service binding stay in the Preview?

**No. It resolves to the PRODUCTION deployment, and the Durable Object writes it makes land in
PRODUCTION's namespace — while the Preview's own auto-provisioned namespace sits unused.
Nothing errors.** Probed 2026-09-22 against wrangler 4.136.2, `preview` open beta.

## Why it was asked

The [Previews docs](https://developers.cloudflare.com/workers/previews/resources/) answer the A→B
case — *"The Preview of Worker A can only bind to the production Worker B"* — but never the **A=B**
case, which is the shape `apps/nebula/wrangler.jsonc` actually uses: two service bindings naming
its own worker with a named entrypoint, `AUTH_EMAIL_SENDER` and `NEBULA_AUTH_FACADE`.

A throwaway worker rather than a Preview of `nebula` itself, per `workflow.md` § *Experiments* —
and it isolates better: no container build, no DO-class registry debt on the real worker.

## Method

One worker, two counters that cannot be confused. `MARKER` is `"production"` at the top level and
`"preview"` under `previews.vars`, so every response says which deployment answered. A `Counter` DO
bumps a stored integer, so the two namespaces run visibly different sequences. `/` reports both the
**local** marker+bump and the marker+bump fetched **through the SELF binding**.

## Result

| Call | local marker | local counter | viaSelf marker | viaSelf counter |
|---|---|---|---|---|
| production | `production` | 6 | `production` | 7 |
| **preview** | **`preview`** | **1** | **`production`** | **8** |
| **preview** (again) | **`preview`** | **2** | **`production`** | **9** |
| production (after) | `production` | 10 | `production` | 11 |

Read the counter column pair. The Preview's *direct* DO access runs its own sequence from 1 — the
auto-provisioned namespace is real and is isolated, exactly as documented. Its *self-binding* calls
continue **production's** sequence instead (7 → 8 → 9 → 10), so both the code and the storage
crossed over. Two counters side by side in one worker, and one of the two paths left the Preview.

## Finding 2 — the `previews` block is NOT an override layer

The first attempt returned `1101` on every Preview request. Cause: **neither binding existed in the
Preview's env** — `typeof env.COUNTER` and `typeof env.SELF` were both `"undefined"`, while
`previews.vars` *had* applied. Both had to be restated under `previews.durable_objects.bindings`
and `previews.services` before the Preview would boot.

The docs do say *"Add `previews.durable_objects.bindings` only if your code reads the binding from
env"* — literally true, and it reads as an edge case rather than as "every real worker." This half
is at least **loud**: an undeclared binding is a `1101` on the first request, not a silent
divergence.

## What it means for `apps/nebula`

A Preview of `nebula`, configured the obvious way, would take its `NEBULA_AUTH_FACADE` calls — every
authenticated-session Registry mutation, invites included — to **production's** `NebulaAuthRegistry`
DO, and send its auth mail from production's `NebulaEmailSender`. Its own isolated namespace would
hold the Universe/Galaxy/Star writes and nothing else. The Preview would look healthy throughout.

So Previews do not give `apps/nebula` an isolated CI target as configured today. Closing it means
removing the self-bindings — dispatching both entrypoints in-process rather than through a service
binding — which is a design change with its own merits and its own review, not a config tweak.

## Re-running

```sh
cd experiments/preview-self-binding
npx wrangler@4.136.2 deploy                 # production arm
npx wrangler@4.136.2 preview --name probe   # preview arm
curl https://experiment-preview-self-binding.transformation.workers.dev/
curl https://probe-experiment-preview-self-binding.transformation.workers.dev/
```

Cleanup is a dashboard project-delete of `experiment-preview-self-binding`, which also removes both
DO namespaces ([[wrangler-delete-leaves-do-data]]).
