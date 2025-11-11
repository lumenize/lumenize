# Documentation Workflow Command

Create high-quality, validated documentation using the 4-phase workflow.

## Usage

`/documentation-workflow` or `/documentation-workflow <package-name>`

## Description

This workflow prioritizes narrative clarity first, then validation. It maximizes efficiency by avoiding expensive build cycles during iteration and ensures documentation serves human learners, not just technical correctness.

**Key Principle**: Write for humans first, validate with machines second.

## Steps

### Phase 1: Narrative & Pedagogy First 🎨

**Goal:** Get the story right before worrying about validation.

1. **AI agent** writes compelling documentation narrative in `.mdx` files in `/website/docs/[package-name]/`
2. **AI agent** creates pedagogical code examples inline, focusing on teaching value
3. **AI agent** uses `@skip-check` annotations temporarily for all examples
4. **Human** reviews narrative, structure, and teaching clarity
5. **Human** approves narrative before proceeding to Phase 2

**Deliverable:** Draft `.mdx` file(s) with narrative and `@skip-check` examples that teach clearly.

### Phase 2: Make Examples Real 🔨

**Goal:** Create validation infrastructure without disrupting the narrative.

1. **AI agent** writes working test files in `test/for-docs/` directory
2. **AI agent** makes tests match the pedagogical examples from Phase 1
3. **AI agent** exports any DOs or classes shown in doc examples
4. **AI agent** replaces `@skip-check` with `@check-example('path/to/test.ts')` annotations
5. **AI agent** makes minor tweaks to `.mdx` examples to match reality
6. **Human** runs tests to verify they pass: `npm test`
7. **Human** approves test implementation before proceeding to Phase 3

**Deliverable:** Working test files with pedagogical examples that mirror the `.mdx` content.

### Phase 3: Fast Validation Loop ⚡

**Goal:** Lock in example correctness with fast feedback.

1. **Human** runs `npm run check-examples` from `/website` folder
2. **AI agent** reviews any errors and identifies mismatches
3. **AI agent** fixes mismatches between docs and tests using `// ...` wildcards where appropriate
4. **Human** runs `npm run check-examples` again
5. Repeat steps 2-4 until all examples pass
6. **Human** approves validated examples before proceeding to Phase 4

**Deliverable:** All examples passing `check-examples` (output: "✅ All N code examples verified successfully!")

### Phase 4: API Documentation (TypeDoc) 📚

**Goal:** Generate and validate API reference documentation from JSDoc comments.

1. **AI agent** makes 1st draft of JSDoc comments while writing the code. This has already happened by the time we start this documentation workflow.
2. **Human** uses `npm run start` to review JSDoc as they render in website and either hand edits or asks AI agent to make change until Human is happy with how they read and look
3. **Human** runs `npm run build` from `/website` to generate TypeDoc
4. **AI agent** reviews generated API docs for issues
5. **Human** approves final TypeDoc output before proceeding to Phase 5

**Deliverable:** TypeDoc API reference generated without errors, clean API surface visible.

**JSDoc Best Practices:**
- **Link to full docs, don't duplicate examples** - Use `@see [Documentation Name](/docs/package/page)` instead of lengthy `@example` blocks
- **Markdown links work in JSDoc** - Standard markdown syntax `[text](url)` renders correctly in TypeDoc
- **Keep JSDoc focused** - Parameter descriptions, return types, brief explanation only
- **Hide internal types** - Use `@internal` tag for types/interfaces users shouldn't directly use (e.g., `DebugLogOutput`, `DebugLevel`)
- **Clean API surface** - Only export what users need; internal utilities can be imported directly from source when needed

### Phase 5: Full Build & Polish 🏗️

**Goal:** Production-ready documentation with all validations passing.

1. **Human** runs full website build: `npm run build` from `/website`
2. **AI agent** reviews build errors (TypeScript errors, broken links, etc.)
3. **AI agent** fixes any build issues
4. **Human** runs `npm run build` again
5. Repeat steps 2-4 until build succeeds
6. **AI agent** verifies examples still pass (should from Phase 3)
7. **Human** reviews final documentation on local build

**Deliverable:** Website builds successfully with all tests, examples, and API docs validated.

## When to Move Between Phases

**Phase 1 → 2:** Wait for explicit approval on narrative structure
**Phase 2 → 3:** Confirm tests are written and passing  
**Phase 3 → 4:** All examples passing `check-examples`, ready for API doc generation
**Phase 4 → 5:** TypeDoc generated successfully, ready for final build

**General Rule:** Don't skip ahead to validation before narrative is solid.

## Teaching Clarity Principles

Documentation must be **pedagogically clear**, not just technically accurate:

1. **Show Inputs AND Outputs** - Always show what comes back with `expect()` clauses
2. **One Call > Multiple Calls** - Show the common pattern clearly, not every variation
3. **Minimal Classes** - Two DOs showing all patterns > five DOs showing one each
4. **Complete But Minimal** - Show full interaction in one place, not traced across files
5. **Concrete Over Abstract** - Use `'user-1'` not `userId` variable
6. **Local Over Traced** - Complete interaction in one place, not across multiple files
7. **Teaching Over Comprehensive** - One perfect example > five confusing ones

## Wildcard Patterns

Use `// ...` or `/* ... */` to skip boilerplate:

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

## Reference

- **Full workflow document**: `/DOCUMENTATION-WORKFLOW.md`
- **check-examples tool**: `/tooling/check-examples/`
- **Documentation rules**: `.cursor/rules/documentation.md`

