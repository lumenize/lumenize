---
paths:
  - "apps/nebula-studio-ui/**"
---

# UI Routing — the URL is read in one place and written by one function

[ADR-017](../../docs/adr/017-the-url-is-the-view-state.md) says WHAT rides the URL. This file says how,
so that there is one way.

**`apps/nebula-studio-ui/src/view-state.ts` is the ONLY file that touches `location`, `history`, or
`popstate`.** A component MUST reach the URL through what it exports and nothing else:

- **`viewState`** — the URL as a reactive view-state object; read it with `computed`. It is the only
  reader, so every screen in both SPAs (Studio and the auth screens) agrees on what the URL says.
- **`navigate(patch, { replace })`** — the only same-document writer. History API, so no request and no
  reload; opening pushes an entry so Back closes; closing goes back over an entry this page pushed.
  Our own `pushState` fires no event, which is why this writer updates `viewState` itself and one
  `popstate` listener covers the browser's own moves — two paths in, one reactive source out.
- **`forgetQuery(names)`** — drops a parameter the URL must not keep once read, such as a link's
  `token`, in place and with no history entry.
- **`leaveTo(url)`** — the only cross-document move (into an app, to login, to Home). A full load on
  purpose: a different scope is a different socket and token, and the auth screens are a different
  bundle. It exists so those moves stay visible and countable.
- **`scopeUrl(scope, path)` and `platformUrl(path)`** — spell another page's URL. The host is the
  scope (ADR-021), so on `lumenize.dev`, `scopeUrl('acme.crm')` is `https://crm.acme.lumenize.dev/`;
  `pageScope` is the scope this page's own host spells.

**The module stores nothing.** Where a person was when they left for a login rides the login's
`return_to`: the page names itself, the login page hands it to `email-magic-link`, which checks it and
stores it with the link, and the link's page sends the person back.

`npm run audit:urls` (in `apps/nebula-studio-ui`) is the proof, and MUST run after touching routing: it
fails on any read of a `location` part, the host and origin included, any `location` or `history` move, and any `popstate` listener, outside that file.

Vue Router is held until routes multiply — a dependency for a few `/auth/` pages and a few query
flags (`workflow.md` § *Dependencies*). The module is the pattern until then, and a generated app is the
likelier first adopter, since the codegen model knows the router cold.
