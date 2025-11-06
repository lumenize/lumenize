# Testing Patterns

Testing philosophy, patterns, and conventions for Lumenize.

## Philosophy

### Test Types Priority

1. **Integration testing** is primary for Worker/DO code (dogfood our own testing packages)
2. **Unit testing** only for algorithmically tricky code and UI components

**Why:** Integration tests validate real behavior, unit tests require extensive mocking for Worker/DO code.

### Coverage Targets

- ✅ **Branch coverage**: Close to 100%, minimum 80%
- ✅ **Exception conditions**: Only uncovered exception paths are acceptable

## Test Organization

### For Documentation Examples

**Always:**
- ✅ Create tests in `test/for-docs/` directory
- ✅ Use `@check-example` annotations in `.mdx` files
- ✅ Keep tests pedagogical and minimal
- ✅ Export DOs/classes shown in doc examples

**Never:**
- ❌ Don't modify existing integration tests for docs
- ❌ Don't create separate test projects unless genuinely needed

**Why:** Existing tests serve their purpose. Documentation validation needs separate, minimal, teaching-focused tests.

## Testing Patterns

### Prefer `vi.waitFor` Over `setTimeout`

**Always:**
```typescript
// ✅ GOOD: Retries until condition met
await vi.waitFor(async () => {
  const status = await client.taskStatus;
  expect(status).toBe('complete');
}, { timeout: 1000 });
```

**Never:**
```typescript
// ❌ BAD: Fixed delay, might be too short or too long
await new Promise(resolve => setTimeout(resolve, 500));
const status = await client.taskStatus;
expect(status).toBe('complete');
```

**Why:** 
- `vi.waitFor` is faster (returns as soon as condition is met)
- More robust (retries until success or timeout)
- Fails fast if something is wrong
- Default 1s timeout is usually sufficient

**Exception:** Only use `setTimeout` if `vi.waitFor` truly won't work for your use case.

### Put All Expectations Inside `vi.waitFor`

**Always:**
```typescript
await vi.waitFor(async () => {
  const result = await client.getResult();
  expect(result.status).toBe('complete');
  expect(result.data).toBeDefined();
}, { timeout: 2000 });
```

**Why:** Ensures all assertions are retried together until they all pass.

## Test Execution

### Running Tests

```bash
vitest --run
```

### Running Specific Tests

```bash
vitest --run <file-pattern>
```

## API Refactoring Pattern

When refactoring package APIs:

1. ✅ Mark **one test** as `.only` to verify the new pattern works
2. ✅ Once working, update remaining tests
3. ❌ Never leave `.only` in committed code

**Why:** Validates new API incrementally without breaking entire test suite.

## Test Principles

### Tests Enable Refactoring

**Always:**
- ✅ Remove functionality rather than maintain tests for deprecated code
- ✅ Fix tests properly after refactors, don't create aliases
- ✅ Delete tests for removed features

**Never:**
- ❌ Don't make tests pass at all costs after a refactor
- ❌ Don't create technical debt to avoid test updates
- ❌ Don't let tests ossify and prevent necessary changes

**Why:** Tests should enable confident refactoring, not prevent it.

## Reference

For vitest configuration patterns, see package-level `vitest.config.js` files.
For test organization examples, see `packages/testing/` and `packages/rpc/test/`.

