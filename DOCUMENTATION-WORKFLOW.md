# Documentation Workflow

This document describes the phased approach for creating high-quality, validated documentation for Lumenize utilities and features.

## Integration with Task Management

**For new features using the docs-first workflow** (see `/task-management` command):
- Start this workflow **before implementation** to design the API from the user's perspective
- The task file will point to the MDX you create here as the design document
- Complete Phases 1-3 of this workflow, get maintainer approval, then begin implementation
- After implementation, complete Phases 4-5

**For features already implemented** (implementation-first workflow):
- Start at Phase 1 with working code to reference
- All phases apply as documented below

## Overview

Documentation follows a **5-phase workflow** that prioritizes narrative clarity first, then validation. This approach maximizes efficiency by avoiding expensive build cycles during iteration and ensures documentation serves human learners, not just technical correctness.

**Key Principle**: Write for humans first, validate with machines second.

---

## Phase 1: Narrative & Pedagogy First 🎨

**Goal**: Get the story right before worrying about validation.

### What to Do:
- ✅ Write compelling documentation narrative in `.mdx` files
- ✅ Create pedagogical code examples inline
- ✅ Focus on teaching value and clarity
- ✅ Iterate rapidly on wording, structure, and examples
- ✅ Use `@skip-check` annotations for now

### What NOT to Do:
- ❌ Don't write test files yet
- ❌ Don't run `npm run check-examples`
- ❌ Don't build the website
- ❌ Don't modify existing tests
- ❌ Don't worry about technical correctness yet

### Teaching Clarity Guidelines

Documentation must be **pedagogically clear**, not just technically accurate. Human learners need simple, direct examples with visible results.

#### Concise Clarity Principles:

1. **Show Inputs AND Outputs**
   ```typescript
   // ❌ BAD: No visible result
   const result = await stub.echo('Hello');
   
   // ✅ GOOD: Shows what comes back
   const result = await stub.echo('Hello');
   expect(result).toBe('DO echoed: Hello');
   ```

2. **One Call > Multiple Calls unless the point of the section is to show flexibility or altneratives**
   ```typescript
   // ❌ BAD: Three redundant calls if this is the first example. BAD because the MAIN 
   // point is to show that you can use the PascalCase class identifier more than to show 
   // that you can use the other cases also. Follow up this first example with ones that
   // show flexibility, alternatives, and limits
   const r1 = await this.svc.call('UserDO', id).method();
   const r2 = await this.svc.call('USER_DO', id).method();
   const r3 = await this.svc.call('userDo', id).method();
   
   // ✅ GOOD: One clear call with explanation
   const result = await this.svc.call('UserDO', id).method();
   expect(result).toBe('expected value');
   // Works with any case: 'USER_DO', 'userDo', etc.
   // Maybe the comment above is good enough. Maybe you want another example
   ```

3. **Minimal Classes**
   ```typescript
   // ❌ BAD: Five different DO classes to show one concept
   class UserDO, OrderDO, ChatDO, NotificationDO, WorkflowDO...
   
   // ✅ GOOD: Two DOs showing all patterns
   class UserDO { /* standalone + single-param */ }
   class NotificationDO { /* LumenizeBase pattern */ }
   ```

4. **Complete But Minimal**
   ```typescript
   // ❌ BAD: Incomplete snippet
   async notifyUser(userId: string) {
     await this.svc.call('UserDO', userId).notify();
   }
   
   // ✅ GOOD: Complete with visible result
   class NotificationDO extends LumenizeBase<Env> {
     async notifyUser(userId: string, msg: string) {
       const result = await this.svc.call('UserDO', userId).echo(msg);
       expect(result).toBe('DO echoed: Hello!');
     }
     // ...
   }
   ```

5. **Concrete Over Abstract**
   ```typescript
   // ❌ BAD: Abstract variable names
   const result = await doStub.processData(payload);
   
   // ✅ GOOD: Concrete, relatable
   const result = await call({ env })('UserDO', 'user-1').echo('Hello');
   expect(result).toBe('DO echoed: Hello');
   ```

6. **Local Over Traced**
   - **Don't**: Show complex call chains across multiple files, functions, or classes
   - **Do**: Show the complete interaction in one place
   - **Remember**: Humans can't trace call stacks in their head like LLMs can

7. **Teaching Over Comprehensive**
   - **Don't**: Try to show every possible use case
   - **Do**: Show the most common, most useful pattern clearly
   - **Remember**: One perfect example > five confusing ones

### Deliverable:
Draft `.mdx` file(s) with narrative and `@skip-check` examples that teach clearly.

---

## Phase 2: Make Examples Real 🔨

**Goal**: Create the validation infrastructure without disrupting the narrative.

### What to Do:
- ✅ Write actual working test files (usually in `test/for-docs/`)
- ✅ Make tests match the pedagogical examples from Phase 1
- ✅ Export any DOs or classes shown in doc examples
- ✅ Add `@check-example` annotations to `.mdx` files
- ✅ Make minor tweaks to `.mdx` examples to match reality

### What NOT to Do:
- ❌ Don't run `check-examples` yet (wait for Phase 3)
- ❌ Don't modify the narrative structure from Phase 1
- ❌ Don't build the website yet

### Test Writing Guidelines:
- Tests should be **pedagogical**, not comprehensive
- Keep test code simple and readable (humans will read it via docs)
- Use descriptive names: `call-usage.test.ts`, not `test-1.test.ts`
- Export DOs/classes shown in doc examples: `export { UserDO };`
- No need to export or import test helpers like `expect` - they're self-documenting
- Add comments in tests explaining non-obvious setup

### Deliverable:
Working test files with pedagogical examples that mirror the `.mdx` content.

---

## Phase 3: Fast Validation Loop ⚡

**Goal**: Lock in example correctness with fast feedback.

### What to Do:
- ✅ Run `npm run check-examples` from `/website` folder
- ✅ Iterate on examples until all pass
- ✅ Use `// ...` or `/* ... */` wildcards to skip boilerplate
- ✅ Refresh your memory of other liency allowed by looking in `tooling/check-examples`. For instance `import` statements are skipped
- ✅ Enhance the `check-examples` tool if needed
- ✅ Fix mismatches between docs and tests

### What NOT to Do:
- ❌ Don't run full website build yet (too slow, too many tokens)
- ❌ Don't worry about TypeScript errors in other files yet
- ❌ Don't worry about broken links yet

### Common check-examples Patterns:
```typescript
// Skip imports in doc example
class MyDO extends DurableObject {
  /* ... */
}

// Skip boilerplate in doc example
async method() {
  // ...
  const result = await importantCall();
  expect(result).toBe('value');
}
```

### Tool Enhancement:
If you find yourself fighting `check-examples` repeatedly:
1. Propose an enhancement to the tool (e.g., new wildcard pattern)
2. Implement it in `tooling/check-examples/src/index.js`
3. Document the new pattern here

### Deliverable:
All examples passing `npm run check-examples` (output: "✅ All N code examples verified successfully!")

---

## Debugging Website Issues 🐛

**Goal**: Debug rendering, TypeScript, or other website issues without expensive build cycles.

### Primary Method: Development Server

**Always use `npm run start` for debugging** instead of full builds:

```bash
cd /Users/larry/Projects/mcp/lumenize/website
npm run start
```

### Why `npm run start`?
- ✅ **Shows errors without blocking**: check-examples failures are reported but don't stop the dev server
- ✅ **Live preview**: See rendered output immediately in browser
- ✅ **Fast iteration**: Hot reload on file changes
- ✅ **Cheap**: Minimal token usage, no verbose build output
- ✅ **Real rendering**: Catches MDX/React issues that static analysis misses

### When to Use Full Builds

Only use `npm run build` when:
- ✅ Debugging SSG-specific issues (static site generation errors)
- ✅ Final validation before completion
- ✅ Verifying production build succeeds

### Debugging Workflow

1. **Start dev server**: `npm run start`
2. **Navigate to problem page**: Check rendering and console
3. **Fix issues iteratively**: Edit files, check browser reload
4. **Run check-examples separately** (if needed): `npm run check-examples`
5. **Final build** (Phase 5): `npm run build`

### Common Website Issues

**TypeDoc JSDoc Examples:**
- Problem: Code in `@example` tags gets evaluated by MDX
- Solution: Remove type annotations (`: Type`) and object shorthand (`{ env }` → `{ env: environment }`)
- Example: `async fetch(request, env, ctx)` instead of `async fetch(request: Request, env: Env)`

**check-examples Errors:**
- Problem: Test files moved during refactoring
- Solution: Update `@check-example('path/to/test.ts')` paths in `.mdx` files

**Broken Links:**
- Problem: Links to non-existent anchors or pages
- Solution: Use `npm run start` to see broken link warnings in dev server output

---

## Phase 4: API Documentation (TypeDoc) 📚

**Goal**: Generate and validate API reference documentation from JSDoc comments.

### What to Do:
- ✅ Ensure JSDoc comments are complete and accurate for all exported functions/classes
- ✅ Fix JSDoc `@example` code blocks to avoid MDX evaluation issues
- ✅ Verify proper exports in `src/index.ts` (only expose public API)
- ✅ Generate TypeDoc by running `npm run build` from `/website`
- ✅ Review generated API docs at `/docs/[package]/api/`
- ✅ Iterate on JSDoc comments until API docs are clear

### What NOT to Do:
- ❌ Don't skip this phase for packages with public APIs
- ❌ Don't export internal types/utilities (they'll appear in docs)
- ❌ Don't use complex type annotations in JSDoc examples

### JSDoc Example Pitfalls

TypeDoc generates markdown that gets processed by MDX. Avoid these issues:

**Type Annotations:**
```typescript
// ❌ BAD: MDX tries to evaluate undefined types
async fetch(request: Request, env: Env)

// ✅ GOOD: No type annotations
async fetch(request, env, ctx)
```

**Generic Type Parameters:**
```typescript
// ❌ BAD: Undefined type reference
class MyDO extends LumenizeBase<Env>

// ✅ GOOD: No generic
class MyDO extends LumenizeBase
```

### Controlling API Surface

**Primary strategy - Only export what users should see:**
```typescript
// src/index.ts - Clean public API
export { publicFunction } from './public-api';
export type { PublicType } from './public-api';

// Internal utilities NOT exported
// Other packages can still import:
// import { internal } from '@lumenize/pkg/src/internal.js'
```

**Alternative - Use @internal tag:**
```typescript
/**
 * @internal
 * Internal utility, hidden from docs
 */
export function internalHelper() { }
```

### Deliverable:
- ✅ TypeDoc generates without errors
- ✅ API docs show only public API
- ✅ Examples in API docs render correctly
- ✅ No "X is not defined" errors in build

---

## Phase 5: Full Build & Polish 🏗️

**Goal**: Production-ready documentation with all validations passing.

### What to Do:
- ✅ Run full website build: `npm run build` from `/website`
- ✅ Fix TypeScript errors reported by build
- ✅ Fix broken internal links
- ✅ Fix any other build issues
- ✅ Verify examples still pass (they should from Phase 3)

### What NOT to Do:
- ❌ Don't change narrative structure at this stage
- ❌ Don't add new examples (go back to Phase 1 if needed)

### Build Output Management:
- The build output is verbose and token-heavy
- Use grep to filter relevant errors: `npm run build 2>&1 | grep -E "(error|ERROR|SUCCESS)"`
- Only show full output when debugging specific issues

### Common Issues:
1. **TypeScript errors in doc test files**: Usually incorrect signatures
2. **Broken links**: Check internal doc links with Docusaurus path format
3. **Missing TypeDoc files**: Ensure `tsconfig.build.json` exists and excludes tests

### Deliverable:
- ✅ Website builds successfully: `[SUCCESS] Generated static files in "build"`
- ✅ All tests pass
- ✅ All examples validated

---

## When to Move Between Phases

**Between Phase 1 → 2:**
- Wait for explicit approval on narrative structure
- Confirm teaching approach is clear and correct
- Ensure examples are pedagogically sound (even if not yet valid code)

**Between Phase 2 → 3:**
- Confirm tests are written and passing
- Verify `@check-example` annotations are added
- Ready to start validation loop

**Between Phase 3 → 4:**
- All examples passing `check-examples`
- No more narrative changes needed
- Ready to generate API documentation

**Between Phase 4 → 5:**
- TypeDoc generated successfully
- API docs reviewed and approved
- Ready for final production build

**General Rule**: Don't skip ahead to validation before narrative is solid. Iterating on narrative is cheap. Iterating on tests and builds is expensive.

---

## Why This Workflow

### Token Efficiency
- No expensive build output in context during iteration
- Fast feedback loops (`check-examples` runs in milliseconds)
- Only one full build at the end

### Time Efficiency
- Fast loops before slow loops
- Narrative iteration doesn't require test updates
- Validation happens when structure is stable

### Cognitive Clarity
- One concern at a time
- Teaching clarity first, technical correctness second
- Reduces context switching

### Flexibility
- Can iterate on narrative without test overhead
- Tool enhancements emerge organically from Phase 3 friction
- Easy to go back to Phase 1 if narrative needs major changes

---

## Key Learnings from Real Usage

### From `call` Utility Documentation:

1. **Show the result**: Every code example should have an `expect()` clause or comment showing what comes back
2. **Consolidate classes**: Used 2 DOs instead of 5 to show all patterns
3. **One example per concept**: Don't show three variations when one + explanation works
4. **Use wildcards liberally**: `/* ... */` and `// ...` to focus on what matters
5. **Make results visible**: "Returns X" is weaker than `expect(result).toBe("I'm X")`

### From `alarms` Documentation:

1. **Complete examples**: Show full DO class, not just method snippets
2. **Use real values**: `'0 0 * * *'` is better than `cronExpression` variable
3. **Console.log patterns**: Show example output as comments for clarity if it's small
4. **Use `expect(result).toMatch({ a: 1 })`**: If the point is that result is an object that has at least `{ a: 1 }`
5. **Use `expect(result).toMatch({<multi-line-partial-output>})`**: If the point is show some big structure. Note, one of the lines in the multi-line output can be it's own `expect()` clause. Example, `...toMatch({ a: expect.any(Number) })`
6. **Import side effects**: Document when `import '@lumenize/core'` is needed for dependencies

### Documentation Anti-Patterns to Avoid:

- ❌ Multiple redundant examples to prove case-insensitivity
- ❌ Abstract variable names (`data`, `payload`, `result`)
- ❌ Incomplete snippets that don't show the full picture
- ❌ Complex cross-file, cross-function, cross-class interactions
- ❌ Examples without visible outputs
- ❌ Trying to show every edge case instead of common patterns

---

## Reference

- **check-examples tool**: `/tooling/check-examples/`
- **Docusaurus config**: `/website/docusaurus.config.ts`
- **Documentation root**: `/website/docs/`
- **General docs rules**: See `.cursorrules` "Documentation" section

