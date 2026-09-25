---
title: NebulaClient
description: Client-side class for connecting to Nebula.
---

# NebulaClient

`NebulaClient` extends [`LumenizeClient`](/docs/mesh/lumenize-client) with Nebula's **two-scope model**:

- **Auth scope** — the NebulaAuth instance name the user authenticated against (e.g., `acme.app.tenant-a` for a regular user, `acme` for a universe admin). Determines the refresh cookie path.
- **Active scope** — the specific universe, galaxy, or star the client is targeting. Baked into the JWT `aud` claim. For regular users, same as auth scope; for an admin it can be any scope at or below their auth scope.

```typescript @skip-check
// Direct construction — admin/scripting path with explicit scopes.
const client = new NebulaClient({
  baseUrl: 'https://my-app.example.com',
  authScope: 'acme.app.tenant-a',
  activeScope: 'acme.app.tenant-a',
  ontologyVersion: 'v42',                  // the server-installed ontology version (enforced)
});
```

Browser apps don't construct `NebulaClient` directly — they use [`createNebulaClient`](./api-reference.md#createnebulaclient), where `baseUrl`, `activeScope`, and `onShouldRefreshUI` auto-detect. `ontologyVersion` is injected by the serving layer and is absent until an Apply has run — a resource-free app boots without it, and only `resources.*` refuses (`NoOntologyInstalledError`). `authScope` is currently required-in-practice (its URL auto-detect is deferred — omitting it throws a clear error), and the explicit scopes above are the admin/scripting escape hatch.

Switching active scope means creating a new `NebulaClient` with a different `activeScope`. The refresh cookie (scoped to the auth scope path) carries over automatically.

## Calling `@mesh()` members locally

`NebulaClient` subclasses can have `@mesh()` members — a method, or a getter — that DOs reach through the Gateway. The decorator is pure metadata: it marks the member as remotely reachable but does not wrap it. Calling one directly from surrounding JavaScript (e.g., `client.echo('hello')`) executes it normally, with no interception and no guard check. Guards only run when the call arrives via the mesh.

⚠️ **An OVERRIDE needs its own `@mesh()`.** The mark lives on the function, so a subclass member that shadows a marked one carries nothing and a push to it is refused. What you *see* is one step downstream: a `subscribe()` whose push was refused rejects with `never acknowledged`, because the handler that would have settled it never ran. The refusal itself — which names the override — is logged on the client under `lmz.mesh.LumenizeClient.#handleIncomingCall`, so start there rather than at the rejection. Prefer the seams the client already gives you — the store, `subscribeQuery(...).onChange`, `onReload`, `setOnStreamChunk`, `onPreviewReady` — which is what these handlers are built to be extended through.

See [Auth flows](./auth-flows.md) for the full login, returning user, and scope-switching sequences.
