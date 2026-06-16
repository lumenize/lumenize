# Preview-in-iframe Spike (Studio authoring UX)

**Status**: Active — authoring-UX spike, lower priority than the Think-integration and UI-gen prerequisites. Exploratory; not for hand-review.

**Context**: the Studio authoring surface is chat-first with an always-visible live preview (`tasks/nebula-studio.md` § Authoring environment). The preferred mechanism is an **in-window iframe**; the unknowns are auth/CSP/same-origin, not compile speed (the SFC compile + reload broadcast is already ~36 ms p50 deployed).

## Goal

Determine whether the running preview app can embed in an **in-window iframe** with:
- auth context propagated into the iframe (the preview is an authed Nebula client),
- CSP / same-origin constraints satisfied (the generated app needs `unsafe-eval` for template compilation; the editor shell shouldn't),
- the **~3 s save→refresh** target met end-to-end (edit → compile in DevStar → reload broadcast → iframe refresh).

And prototype the fallback when iframe embedding fights us: **seamlessly launch (or focus, if already open) a separate browser window** on the preview URL.

## Loose approach (will evolve)

- Embed the deployed preview in an iframe inside a throwaway shell; check whether the auth cookie/token and the WS connection survive the iframe boundary.
- Probe CSP: can the iframe carry the generated app's `unsafe-eval` need without leaking it to the shell?
- Measure the full save→reload cycle against the ~3 s target.
- Prototype the launch/focus-browser fallback (window handle reuse).

## Notes

- Builds on the SFC compile + reload-broadcast mechanism (`tasks/nebula-studio.md` § Dev-mode Star). The compile loop is solved; this spike is about the **embedding + auth surface**.
- Touches the Studio UI hosting open question (Workers Assets vs Galaxy-served) only tangentially — the shell that hosts the iframe is a separate decision.
