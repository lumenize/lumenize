---
paths:
  - "apps/nebula-studio-ui/**"
  - "apps/nebula/container/app/**"
  - "apps/nebula/src/dev-studio.ts"
  - "**/*.vue"
---

# UI Theming — color goes through the theme, on every surface

⚠️ **This rule is MECHANISM only.** There is **no design guidance in this repo yet, deliberately** —
palette identity, type scale, spacing rhythm, density, and motion are held until the UX hire lands, and
the stock daisyUI themes we currently run are a **placeholder, not a brand decision**. Do not read this
file as permission to author a theme or a design system: it says *how* color is wired, never *what* it
should look like.

## The rule

**Color comes from the daisyUI theme — on both surfaces:** Nebula's own UI (`apps/nebula-studio-ui`)
and the apps Studio generates for user-developers. Use semantic classes (`bg-primary`,
`text-base-content`, `bg-base-200`, `border-base-300`); don't hard-code raw Tailwind palette utilities
(`bg-blue-500`, `text-slate-700`).

To change how something *looks*, change the theme, not the markup — set the theme's color variables in
an `@plugin "daisyui/theme"` block (OKLCH preferred; it's what every built-in theme uses), or switch
built-in themes. Same result on screen, applied everywhere at once.

## Why it applies to both surfaces

The user-developers Nebula targets are typically **highly opinionated about how their UI looks and
indifferent to how that look is achieved.** The mechanism is therefore ours to choose, and choosing
theming makes their opinion *cheap to satisfy* — a brand color is one variable, not a sweep through
every component. Our own UI follows the same rule so the eventual design work lands in one theme block
rather than N files.

## Warn, don't refuse

Consistent with Nebula's governance stance — advisory practices with a documented-exception override,
never hard gates. If a user-developer explicitly wants colors hard-coded into markup, **do it**, but
name the tradeoff once first: those colors stop following the theme, so restyling later means editing
every component, and they won't adapt to light/dark. Say it plainly, once, then follow their decision —
no repeating, no refusing. This is the "no foot-guns — even when we let you break a rule, you're loudly
warned" principle from `CLAUDE.md`, not a gate.

The codegen scaffold (`STUDIO_LOOP_SYSTEM_PROMPT` in [dev-studio.ts](../../apps/nebula/src/dev-studio.ts))
carries this same **default → redirect → warn-and-proceed** shape. Keep the two in sync when either changes.

## Status

Both surfaces were **clean as of 2026-07-23** — `apps/nebula-studio-ui/src/App.vue` and the generated-app
scaffold (`apps/nebula/container/app/`) use semantic classes only, zero raw palette utilities. This rule
is a ratchet on existing practice, not a cleanup task.

Sweep for violations with:

```sh
grep -rnE '\b(bg|text|border|ring|from|to|via|divide|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b' apps/nebula-studio-ui/src apps/nebula/container/app/src
```
