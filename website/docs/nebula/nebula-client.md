---
title: NebulaClient
description: Client-side class for connecting to Nebula.
---

# NebulaClient

`NebulaClient` extends [`LumenizeClient`](/docs/mesh/lumenize-client) with Nebula's **two-scope model**, which the client never configures. Its token carries both:

- **`aud`** — the scope of the page's host. The platform host's refresh reads it from the page's `Origin`, so a client on `https://tenant-a.app.acme.lumenize.dev` gets `aud: "acme.app.tenant-a"`. The client takes its scope from its first token's `aud`, and a call made before that token arrives waits for it.
- **`authScope`** — the membership whose refresh cookie minted the token: the page's own scope for a regular member, or an ancestor for an admin whose membership covers it (`acme` for a universe admin, on any page beneath `acme`).

```typescript @skip-check
// Direct construction — the admin/scripting path, naming the page and the platform host.
const client = new NebulaClient({
  baseUrl: 'https://tenant-a.app.acme.lumenize.dev',   // the page whose host is the client's scope
  platformOrigin: 'https://platform.lumenize.dev',     // where the session lives
  ontologyVersion: 'v42',                  // the server-installed ontology version (enforced)
});
```

Browser apps don't construct `NebulaClient` directly — they use [`createNebulaClient`](./api-reference.md#createnebulaclient), where `baseUrl`, `platformOrigin` and `onShouldRefreshUI` come from the page. `ontologyVersion` is injected by the serving layer and is absent until an Apply has run — a resource-free app boots without it, and only `resources.*` refuses (`NoOntologyInstalledError`).

Moving to another scope means opening its host. The page there has its own client, and the cookies on the platform host cover it wherever a membership does.

## Calling `@mesh()` members locally

`NebulaClient` subclasses can have `@mesh()`-decorated methods and getters that DOs reach through the Gateway. The decorator is pure metadata: it flags the method or getter as remotely reachable but does not wrap it. Calling one directly from surrounding JavaScript (e.g., `client.echo('hello')`) executes it normally, with no interception and no guard check. Guards only run when the call arrives via the mesh.

⚠️ **An OVERRIDE needs its own `@mesh()`.** The decorator records itself on the function, so a subclass method that shadows a `@mesh()`-decorated one carries nothing and a push to it is refused. What you *see* is one step downstream: a `subscribe()` whose push was refused rejects with `never acknowledged`, because the handler that would have settled it never ran. The refusal itself — which names the override — is logged on the client under `lmz.mesh.LumenizeClient.#handleIncomingCall`, so start there rather than at the rejection. Prefer the seams the client already gives you — the store, `subscribeQuery(...).onChange`, `setOnStreamChunk`, `onPreviewReady` — which is what these handlers are built to be extended through.

See [Auth flows](./auth-flows.md) for the full login, returning-user, and moving-between-scopes sequences.
