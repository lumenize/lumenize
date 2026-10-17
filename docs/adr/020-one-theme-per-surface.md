# ADR-020: The Look Goes Through One Theme Per Surface, Declared Once

**Date**: 2026-09-03
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: the first UI-heavy pass (2026-09-03). Every form in Nebula's UI was built on five daisyUI 4 classes that daisyUI 5 no longer ships, so the forms rendered without their spacing and nothing failed — type-check, vitest, the `/live` sweep at 24/24 and ui-smoke were all green. The app shell's root re-selected `dark` while the sign-in screens wore the default theme, so a stranger's first hour went light, dark, light. Three inline styles carried values off the spacing scale. Fixed in `d963a78` and `f019369`.

## Context

Nebula has two styling surfaces. Both are daisyUI on Tailwind v4:

1. **Nebula's own UI**, which includes sign-in, the Universe page, Profile management, and Studio where apps are created, which encompasses the development chat and preview chrome (but not what's inside the preview frames)... and anything else we later add. It is one product. It has a neutral look that will not clash with any color scheme the user-developer's app might choose because those tenant users will see pieces of Nebula, like login and Profile management screens, in their daily use.
2. **The user-developer's app**. We assume that user-developers are **highly opinionated about how their UI looks and indifferent to how that look is achieved.** The mechanism is therefore ours to choose, and theming is the one that makes their opinion cheap to satisfy: a brand color is one variable, not a sweep through every component. Nebula's own UI takes the same mechanism so that the design work, when it lands, lands in one block rather than in N files.

`ui-theming.md` has carried theming as a convention; this ADR makes it the commitment, and adds what the convention did not say: where a look is *declared*, whether markup may carry anything beyond semantic classes, and how anyone would learn that the installed daisyUI has stopped defining a class the markup uses.

Tailwind emits CSS only for the utilities it finds in the sources, and daisyUI defines only the component classes its version ships. A class name that neither tool recognises is silently dropped: no CSS, no warning, no build error. That is how the forms in § *Evidence* lost their spacing, and why no tier could notice: every test asserts on what a screen *says*, and an unspaced screen says all of it.

## Decision

1. **Color comes from the theme, on every surface.** Nebula's UI and the generated apps alike use daisyUI's semantic classes (`bg-primary`, `text-base-content`, `border-base-300`). A raw Tailwind palette utility (`bg-blue-500`) is never hard-coded in Nebula's UI, and in a generated app it is the warned exception of decision 3. To change how something looks, change the theme, not the markup: the same result on screen, applied everywhere at once.

2. **A surface wears one theme, declared in one place.** Nebula's UI — every screen of it, sign-in and the Universe page included, and every screen to come — is one surface, and its theme is the `@plugin "daisyui/theme"` block in `apps/nebula-studio-ui/src/style.css`. No element re-selects a theme: a `data-theme` on a node is a second declaration site, which is exactly what produced the light-dark-light hour. A dark variant, should anyone want one, is still that one block — `prefersdark` to follow the system, or a second theme that a root-level toggle selects for the whole surface — never a choice made on an element inside it. No markup carries a color, an inline style, or a value off the spacing scale. What the block holds — the decided base, and what is still deferred — is `ui-theming.md`'s to say, not this ADR's.

3. **A generated app is the user-developer's surface.** It wears its own theme block in its own `style.css` — stock daisyUI until the user-developer says otherwise, which is what the scaffold at `apps/nebula/container/app/src/style.css` ships — and never Nebula's. Studio around the preview is ours; the preview is theirs — and what they do inside it is theirs too: hard-coded color in their markup is discouraged but not disallowed (`ui-theming.md` § *Warn, don't refuse*). The platform layer of the guidance tree (`apps/nebula/platform/AGENTS.md`, read by the model on every turn) already tells the model to change the theme rather than the markup, and it keeps the same shape as decision 1.

4. **Markup uses only class names that the installed daisyUI and Tailwind define, and the build proves it.** daisyUI's component classes (`fieldset`, `btn`, `modal`) are whatever the version in `package.json` ships, and they change across majors — v5 dropped the v4 form classes (§ *Evidence*). So the rule is not "use daisyUI 5's classes" but "use the classes the installed version defines", and the check runs against the build rather than against any document: every class token in Nebula's UI sources must appear in the built CSS (`npm run audit:classes` in `apps/nebula-studio-ui`). A bump that renames a component then fails that command instead of a screen. This ADR names no version for the same reason: the build knows which one is installed, and the audit reads what it produced.

## Alternatives considered

- **One theme for both surfaces, generated apps included.** Rejected. A Nebula palette on a generated app puts our brand on someone else's product, and their first theme edit would begin by removing ours instead of starting from neutral — which is why the scaffold ships stock daisyUI.
- **Per-surface `data-theme` as the mechanism.** It is daisyUI's own way to theme a region, and it stays right for a region that *is* a different surface (the preview frame). For Nebula's UI it is rejected: with one surface a second site can only disagree with the first, and a reviewer reading a `.vue` cannot tell which theme a node will end up in. § *Evidence* records the disagreement that shipped.
- **A stylesheet linter or a Tailwind plugin instead of the class-existence audit.** Deferred. The audit is one dependency-free script that compares source tokens with the built CSS; a linter would be a dependency (`workflow.md` § *Dependencies*) for a check that has so far had exactly one class of finding. Revisit when it has a second.

## Consequences

- A brand color for a generated app is one variable in its block; Nebula's is one variable in ours. Restyling either touches no `.vue`.
- The audit is a class-existence check and nothing more. It cannot tell a wrong class from a right one, only an undefined one; a form built on the wrong *component* still needs eyes — a human driving the screen first, and the `/live` captures as the standing second look.
- Nothing here decides a design value. What is decided and what is still deferred is stated once, in `ui-theming.md`.
