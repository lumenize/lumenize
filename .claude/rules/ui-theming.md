---
paths:
  - "apps/nebula-studio-ui/**"
  - "apps/nebula/container/app/**"
  - "apps/nebula/src/galaxy.ts"
  - "**/*.vue"
---

# UI Theming — the look goes through the theme, on every surface

⚠️ **This rule is MECHANISM only, and the design work is still deferred.** Nebula wears one theme block
(`nebula` in `apps/nebula-studio-ui/src/style.css`): a warm light base, decided 2026-09-03. Everything
past that base — accent identity, type scale, spacing rhythm, density, motion — is held until the design
work lands, and the stock daisyUI values the block inherits for those are a **placeholder, not a brand
decision**. This file MUST NOT be read as permission to grow that block into a design system: it says
*how* the look is wired, never *what* it should look like beyond the base.

The commitment and its argument are [ADR-020](../../docs/adr/020-one-theme-per-surface.md); this file is
the MUSTs that load while you edit.

## The rule

**Color MUST come from the daisyUI theme — on both surfaces:** Nebula's own UI (`apps/nebula-studio-ui`)
and the apps Studio generates for user-developers. Semantic classes (`bg-primary`, `text-base-content`,
`bg-base-200`, `border-base-300`) MUST be used, and raw Tailwind palette utilities (`bg-blue-500`,
`text-slate-700`) MUST NOT be hard-coded.

To change how something *looks*, you MUST change the theme rather than the markup — set the theme's
color variables in an `@plugin "daisyui/theme"` block (OKLCH preferred; it's what every built-in theme
uses), or change which theme the block declares as `default:` / `prefersdark:`. Same result on screen,
applied everywhere at once. ⚠️ The switch is one choice for the whole surface — the block's `default:` /
`prefersdark:`, or a root-level toggle if one is ever wanted — never a `data-theme` on an element inside it
(next section).

## Where the look is declared

One theme block per surface, and Nebula's own UI is ONE surface, every screen of it — sign-in, the Universe
page, Studio:
`data-theme` on an element inside the surface MUST NOT re-select a theme, and markup MUST NOT carry an inline
style or a value off the spacing scale. Component classes MUST be the ones the daisyUI in use actually
defines — a class it dropped emits nothing and fails no tier (the ADR's § *Evidence* carries the day
it bit). `npm run audit:classes` (in `apps/nebula-studio-ui`) is the check; it MUST run after touching
markup and after any daisyUI or Tailwind version change.

## Warn, don't refuse

If a user-developer explicitly wants colors hard-coded into markup, you **MUST do it**, but MUST name the
tradeoff once first: those colors stop following the theme, so restyling later means editing every
component, and they won't adapt to light/dark. Say it plainly, once, then follow their decision; you
MUST NOT repeat the warning and MUST NOT refuse — an advisory practice with a documented-exception
override, never a gate (`CLAUDE.md`'s "no foot-guns" principle).

The codegen scaffold (`STUDIO_LOOP_SYSTEM_PROMPT` in [galaxy.ts](../../apps/nebula/src/galaxy.ts))
carries this same **default → redirect → warn-and-proceed** shape. The two MUST be kept in sync when either changes.

## Status

Both surfaces were **clean as of 2026-07-23** — `apps/nebula-studio-ui/src/App.vue` and the generated-app
scaffold (`apps/nebula/container/app/`) use semantic classes only, zero raw palette utilities. This rule
is a ratchet on existing practice, not a cleanup task.

The class-existence sweep is `npm run audit:classes` (above). Sweep for raw palette utilities with:

```sh
grep -rnE '\b(bg|text|border|ring|from|to|via|divide|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' apps/nebula-studio-ui/src apps/nebula/container/app/src
```
