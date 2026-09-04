---
paths:
  - "apps/nebula-studio-ui/**"
---

# UI Routing — the URL is read in one place and written by one function

[ADR-017](../../docs/adr/017-the-url-is-the-view-state.md) says WHAT rides the URL. This file says how,
so that there is one way.

**`apps/nebula-studio-ui/src/view-state.ts` is the ONLY file that touches `location`, `history`, or
`popstate`.** It exposes three things, and a component MUST use them and nothing else:

- **`viewState`** — the URL as a reactive view-state object; read it with `computed`. It is the only
  reader, so every screen in both SPAs (Studio and the auth screens) agrees on what the URL says.
- **`navigate(patch, { replace })`** — the only same-document writer. History API, so no request and no
  reload; opening pushes an entry so Back closes; closing goes back over an entry this page pushed.
  Our own `pushState` fires no event, which is why this writer updates `viewState` itself and one
  `popstate` listener covers the browser's own moves — two paths in, one reactive source out.
- **`leaveTo(url)`** — the only cross-document move (into an app, to login, to Home). A full load on
  purpose: a different scope is a different socket and token, and the auth screens are a different
  bundle. It exists so those moves stay visible and countable.

The module's ONE piece of storage is the return-to: `leaveTo(url, { returnHere: true })` remembers the
current path and query in localStorage (`nebula.returnTo` — one value, one hour, cleared on logout), and
Home's router consumes it through `returnTarget` in `auth/home-logic.ts`, honouring only a relative path
under an accepted membership. It MUST NOT ride the URL or the letter: where a person was is what they
were doing, not what they are looking at. localStorage, never sessionStorage — the letter opens in a
new tab.

`npm run audit:urls` (in `apps/nebula-studio-ui`) is the proof, and MUST run after touching routing: it
fails on any `location` / `history` / `popstate` use outside that file.

Vue Router is held until routes multiply — a dependency for one path segment and a few query flags
(`workflow.md` § *Dependencies*). The module is the pattern until then, and a generated app is the
likelier first adopter, since the codegen model knows the router cold.
