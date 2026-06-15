---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Coding Style

- **Private members**: `#` prefix, never the TS `private` keyword — `#` gives true runtime privacy, not just compile-time.
- **Type system**: TypeScript `interface`/`type` definitions are the single source of truth — no second schema language (no Zod, TypeBox, or JSON Schema). For runtime validation at wire/persistence boundaries (e.g. Resources sent over the wire), validate against those same TS types with `@lumenize/ts-runtime-parser-validator`. Background: [docs/adr/001-typescript-as-schema.md](../../docs/adr/001-typescript-as-schema.md).
- **Imports**: `import { x } from '@lumenize/some-package'` for anything exported from a package's `index.ts`. Use a relative import (`./file`) **only** for an item in the *same* package that is *not* exported from its `index.ts`.
- **IDs**: `crypto.randomUUID()` for unordered unique IDs; `ulidFactory({ monotonic: true })` from `ulid-workers` for ordered IDs. **Never `Date.now()`** for IDs or timestamps in Cloudflare — the clock doesn't advance within an invocation, so repeated calls return the same value (duplicate IDs).
- **Optional over nullable**: prefer `field?: T` over `field: T | null`, especially in Resources/ontology types — Lumenize models "field absent = no value" (`{ name: 'a' }`, not `{ name: 'a', parent: null }`). Keep `| null` only when "present-but-null" is semantically distinct from "absent", or when the code specifically exercises JSON-boundary behavior (`undefined` keys drop).
- **JSDoc — write for the distant caller, not the implementation.** The reader who benefits is the one calling from another file who won't open the body (and sees your JSDoc via LSP hover); whoever is editing the file already reads the code, so JSDoc there is near-redundant.
  - **Don't restate the signature.** Types already encode param names, types, optionality, and return shape — echoing them in `@param`/`@returns` is redundant and drifts out of sync (when JSDoc contradicts the type, the type is believed, so stale JSDoc is worse than none). Omit type-only JSDoc; let the signature speak.
  - **Document only what types can't express**: invariants/preconditions, units & formats, side effects, ownership/lifetime, throw/error behavior (esp. cross-boundary typed errors — see [durable-objects.md](durable-objects.md)), and concurrency/billing implications — plus the non-obvious *why*. One crisp sentence beats a paragraph. Cross-cutting conventions belong in `.claude/rules/`, not repeated per symbol.
  - **When to bother**: any symbol read from a distance with a non-obvious contract — an exported API *or* a non-exported helper used widely across the package. Skip it for purely-local symbols read inline; the code is right there.
  - **Examples**: ≤2 lines inline; for more, `@see` a `@check-example`-validated doc under `/website/docs/...` (JSDoc examples aren't validated, so they drift).
