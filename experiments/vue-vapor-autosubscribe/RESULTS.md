# Vue 3.6 Vapor Mode vs. the store factory's auto-subscribe — results

2026-10-03, `vue@3.6.0-rc.10`, `@vitejs/plugin-vue@6.0.9`, jsdom. The factory under test is the real
one in `apps/nebula/src/frontend/create-nebula-client.ts`, driven through the `MockClient` the
`apps/nebula` `frontend` project uses.

## The question

The factory binds each `store.resources.<rt>[<rid>]` read to the reading code's effect scope, as
`getCurrentScope() ?? getCurrentInstance().scope`. A VDOM render never activates its component's
scope, so for templates the factory leans entirely on the second half. Vue 3.6's release notes say
`getCurrentInstance()` returns `null` in a Vapor component. If nothing else were active during a
Vapor render, a component reading a resource would render the empty seed and never subscribe —
with no error.

## Answer: it works, and works better than VDOM

`npm test` — 16/16. Every case runs in three modes: `vdom` (today's shape, on the 3.6 engine),
`vapor` (`createVaporApp`), and `vapor-in-vdom` (`vaporInteropPlugin`).

| Read site | vdom | vapor | vapor-in-vdom |
|---|---|---|---|
| template, first render | ✅ | ✅ | ✅ |
| template, re-render reading a NEW id | ✅ | ✅ | ✅ |
| `computed()`, switch to a never-seen id | ✅ | ✅ | ✅ |
| `v-for` in one template, item added | ✅ | ✅ | ✅ |
| `v-for` of child components, child added | ✅ | ✅ | ✅ |
| unmount unsubscribes everything after grace | ✅ | ✅ | ✅ |
| a REMOVED `v-for` item unsubscribes before unmount | ❌ held to unmount | ✅ | ✅ |

What each read site saw (the `probe()` in every template):

| | `getCurrentScope()` | `getCurrentInstance()` |
|---|---|---|
| VDOM render | `null` | instance |
| Vapor first render (runs during setup) | scope | instance |
| Vapor re-render | **scope** | `null` |

So in Vapor the factory's FIRST branch carries every re-render, and the fallback Vapor removes is
not needed there. Vapor also gives each `v-for` item its own scope, so an item leaving the list
releases its subscription right away instead of at unmount.

**Capable of failing** — `test/mutation-no-scope.test.ts` blanks `getCurrentScope()`. A Vapor
re-render reading a new id then subscribes **0** times, and VDOM still subscribes once through its
fallback. The Vapor pass above therefore comes from the scope path, and the test can see it fail.
(Blanking it does NOT break Vapor's first render: setup still has an instance, and the fallback
covers it. Only the re-render limb isolates the scope path.)

## A pre-existing bug the spike surfaced — not Vapor's, present on 3.5 today

`npm run test:revisit` (3.6) and `npm run test:revisit:35` (the repo's 3.5.34, compiled by 3.5's own
SFC compiler): **2 of 2 fail on both versions.**

A `computed()` that switches to an id the store has **already vivified** never subscribes it. The
two ways an id gets there: read once outside any scope, or read and then released by a component
that has since unmounted. The view then shows whatever is cached and never updates.

Mechanism, from the ordered probes: when a computed's dependency changes, Vue re-evaluates the
getter during the render effect's dirty check, before the render runs. Neither a scope nor an
instance is active there, so the read goes untracked. For a NEVER-seen id this is rescued by
accident: the read vivifies `resources.<rt>[<rid>] = {}`, that write re-dirties the computed, and
the second evaluation lands inside the render where tracking works. An already-vivified id has no
write and no second evaluation.

The same reasoning predicts a `watch`/`watchEffect` getter reading a new id after setup misses too
(not probed).

## Upgrade friction found on the way

Every Vue-ecosystem peer range excludes prereleases: `@vitejs/plugin-vue` declares `vue ^3.2.25`,
`lucide-vue-next` declares `>=3.0.1`, and semver never lets a range match `3.6.0-rc.N`. As a root
workspace this experiment made the repo's `npm install` fail `ERESOLVE`, which is why it is a
standalone install with a local `.npmrc` (`legacy-peer-deps=true`).

`"overrides": { "vue": "$vue" }` in the installing root satisfies both peers, survives `npm ci`, and
— unlike a literal override — re-resolves on a plain `npm install` when the referenced `vue` spec is
bumped (rc.10 → rc.9 checked in a scratch project, lockfile and nested `@vue/*` all followed).

## Bundle size — only a PURE Vapor app is smaller

The generated-app scaffold (`apps/nebula/container/app`) built with `vite build` on 3.6.0-rc.10,
each variant checked with `node --check`. The seed page has no store, so this is the Vue runtime's
share alone; a generated app adds the Nebula client on top.

| Variant | JS, gzip |
|---|---|
| Today: VDOM, `lucide-vue-next` icon | 25.31 KB |
| VDOM, the same icon inlined as SVG (control for the next two) | 24.99 KB |
| A Vapor component in a VDOM app (`vaporInteropPlugin`, `lucide-vue-next` kept) | **50.58 KB** — both runtimes ship |
| Pure Vapor (`createVaporApp`), icon inlined | **14.66 KB** |
| Pure Vapor, Lucide icon from `unplugin-icons` (`compiler: 'vue-vapor'`) | 15.10 KB |

## Icons — `lucide-vue-next` renders NOTHING in a pure Vapor app

`lucide-vue-next` 1.0.0, its renamed successor `@lucide/vue` 1.51.0, and `@iconify/vue` 5.0.3 all
build each icon with `h()`, so each one is a VDOM component. Loaded in Chromium, a pure Vapor app
importing `House` from `lucide-vue-next` rendered a comment node where the `<svg>` belongs. There
was no console message, and the build was green.

`unplugin-icons` 24.0.0 (2026-09-11) has a `compiler: 'vue-vapor'` option and declares
`@vue/compiler-vapor ^3.6.0-rc.5` as a peer. It compiles an Iconify set into native Vapor components
at build time: `import House from '~icons/lucide/house'`, with `@iconify-json/lucide` supplying
Lucide's icons. In Chromium the icon rendered as an `<svg>` with Lucide's two paths and the
component's `class` applied.

## What the Vapor compiler lets through

`@vue/compiler-sfc` 3.6.0-rc.10, `compileScript` on a `<script setup vapor>` SFC:

| Written | Result |
|---|---|
| `v-memo="[a]"` | compiles, and the memo is dropped from the output |
| `@vue:mounted="m"` | compiles |
| `getCurrentInstance()` | compiles, and returns `null` at runtime |
| Options API (`export default { data() {…} }`) | compile error |

So a build gate that only compiles catches the Options API and none of the others.

## Run it

```sh
npm install          # standalone; .npmrc carries legacy-peer-deps for the rc
npm test             # the Vapor matrix + the mutation witness
npm run test:revisit     # the computed-revisit repro on 3.6 (fails while the bug exists)
npm run test:revisit:35  # the same repro on whatever Vue the ROOT node_modules holds
```

⚠️ `test:revisit:35` reads the repo root's `node_modules`, which held 3.5.34 when the numbers above
were taken. Once the repo itself moves to 3.6 it runs on 3.6, and stops being a 3.5 control.
