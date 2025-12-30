# Documentation Workflow

Create high-quality, validated documentation using the 5-phase workflow.

## Usage

`/documentation-workflow` or `/documentation-workflow <package-name>`

## Key Principle

**Write for humans first, validate with machines second.**

---

## Phase 1: Narrative & Pedagogy First

**Goal:** Get the story right before worrying about validation.

### Do:
- Write compelling documentation narrative in `.mdx` files in `/website/docs/[package-name]/`
- Create pedagogical code examples inline, focusing on teaching value
- Use `@skip-check` annotations temporarily for all examples
- Focus on teaching clarity (see Teaching Principles below)

### Don't:
- Write test files yet
- Run `npm run check-examples`
- Build the website

### Deliverable:
Draft `.mdx` file(s) with narrative and `@skip-check` examples that teach clearly.

**Wait for explicit approval on narrative before proceeding to Phase 2.**

---

## Phase 2: Make Examples Real

**Goal:** Create validation infrastructure without disrupting the narrative.

### Do:
- Write working test files in `test/for-docs/` directory
- Make tests match the pedagogical examples from Phase 1
- Export any DOs or classes shown in doc examples
- Replace `@skip-check` with `@check-example('path/to/test.ts')` annotations
- Make minor tweaks to `.mdx` examples to match reality

### Don't:
- Run `check-examples` yet
- Modify the narrative structure from Phase 1
- Build the website yet

### Deliverable:
Working test files with pedagogical examples that mirror the `.mdx` content.

---

## Phase 3: Fast Validation Loop

**Goal:** Lock in example correctness with fast feedback.

### Do:
- Run `npm run check-examples` from `/website` folder
- Iterate on examples until all pass
- Use `// ...` or `/* ... */` wildcards to skip boilerplate
- Fix mismatches between docs and tests

### Deliverable:
All examples passing `check-examples` (output: "All N code examples verified successfully!")

---

## Phase 4: API Documentation (TypeDoc)

**Goal:** Generate and validate API reference documentation from JSDoc comments.

### Do:
- Ensure JSDoc comments are complete and accurate
- Fix JSDoc `@example` code blocks to avoid MDX evaluation issues
- Verify proper exports in `src/index.ts` (only expose public API)
- Use `npm run start` from `/website` to preview
- Generate TypeDoc by running `npm run build` from `/website`

### JSDoc Best Practices:
- Link to full docs, don't duplicate examples: `@see [Documentation Name](/docs/package/page)`
- Keep JSDoc focused: parameter descriptions, return types, brief explanation only
- Hide internal types with `@internal` tag
- Clean API surface: only export what users need

### Don't:
- Use complex type annotations in JSDoc examples (MDX tries to evaluate them)

---

## Phase 5: Full Build & Polish

**Goal:** Production-ready documentation with all validations passing.

### Do:
- Run full website build: `npm run build` from `/website`
- Fix TypeScript errors, broken links, any other build issues
- Verify examples still pass

### Deliverable:
Website builds successfully with all tests, examples, and API docs validated.

---

## Teaching Clarity Principles

1. **Show Inputs AND Outputs** - Always show what comes back with `expect()` clauses
2. **One Call > Multiple Calls** - Show the common pattern clearly, not every variation
3. **Minimal Classes** - Two DOs showing all patterns > five DOs showing one each
4. **Complete But Minimal** - Show full interaction in one place, not traced across files
5. **Concrete Over Abstract** - Use `'user-1'` not `userId` variable
6. **Local Over Traced** - Complete interaction in one place, not across multiple files
7. **Teaching Over Comprehensive** - One perfect example > five confusing ones

---

## Wildcard Patterns

Use `// ...` or `/* ... */` to skip boilerplate in doc examples:

```typescript
class MyDO extends DurableObject {
  /* ... */

  async fetch(request: Request) {
    // ...
    const result = await importantCall();
    expect(result).toBe('value');
  }
}
```

---

## Reference

- **Full workflow document**: `/DOCUMENTATION-WORKFLOW.md`
- **check-examples tool**: `/tooling/check-examples/`
