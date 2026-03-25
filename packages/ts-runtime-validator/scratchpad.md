# ts-runtime-validator Scratchpad

## Future Ideas

### JSDoc Value Constraints
Add runtime value constraints via JSDoc annotations in type definitions:
```typescript
interface User {
  /** @format email */
  email: string;
  /** @min 1 @max 150 */
  age: number;
}
```
The tsc AST already parses JSDoc tags — `ts.getJSDocTags(node)` on property signatures. After tsc type-checking passes, do a second pass reading JSDoc tags and validating values against them. Consider moving defaults to JSDoc too.

### Improved Error Context (task: nebula-5.2.3.5)
Enrich error messages with context from the generated program. Use `toTypeScript()`'s one-property-per-line format + tsc diagnostic line numbers to show the relevant source line. E.g.: `Type 'number' is not assignable to type 'string'. → title: 42,`

### Run tsc in a Dynamic Worker (potentially the primary architecture)
Cloudflare's Dynamic Workers run in the same thread as the parent — no network hop. If they get their own isolate memory budget (separate from the parent's 128MB), the 40-50MB tsc memory tradeoff disappears entirely. The parent DO stays lean, the DW handles validation.

**Key question to answer first:** Do Dynamic Workers share the parent's isolate memory budget or get their own? There's no `process.memoryUsage()` in Workers, so test empirically: load tsc in a DW alongside a DO near its memory limit and see if it OOMs. Or ask on Cloudflare Discord / file a docs issue.

If separate budgets: make this the default architecture. Add a `createValidator()` helper that spins up a DW with the bundled tsc and returns a `validate()` function. The API stays identical but memory cost moves out of the caller's budget.

If shared budgets: still useful for keeping the tsc bundle out of the main Worker's startup, but doesn't solve the memory constraint. Document as an optimization option.

Spike A1 already confirmed tsc runs in DWL at 1ms/call (see `tasks/archive/nebula-ts-as-schema-research.md`).

### RequestSync / ResponseSync in lib.d.ts
`toTypeScript()` already serializes these via `emitRequestSync`/`emitResponseSync`, but tsc can't validate against them because the minimal lib.d.ts lacks their constructor signatures. Would need minimal structural type definitions (just constructors, not the full class). Low priority — only relevant for `@lumenize/fetch` users, and Nebula users access these through higher-level APIs.
