# API Refactor Command

Safely refactor package APIs with incremental test validation.

## Usage

`/api-refactor <package-name>`

## Description

When refactoring a package's public API, this workflow validates the new pattern incrementally without breaking the entire test suite.

## Steps

1. **Human** identifies API that needs refactoring and explains the change
2. **AI agent** reviews the current API usage across tests
3. **AI agent** selects one representative test file
4. **AI agent** marks that test as `.only` to isolate it
5. **AI agent** implements the new API pattern in that test
6. **Human** runs `npm test` to verify the isolated test passes
7. **AI agent** reviews results and fixes any issues
8. Repeat steps 6-7 until the `.only` test passes
9. **AI agent** updates remaining tests to use new API pattern
10. **AI agent** removes the `.only` marker
11. **Human** runs full test suite: `npm test`
12. **AI agent** fixes any remaining test failures
13. **Human** confirms all tests pass

## Always

- ✅ Mark exactly **one test** as `.only` during initial validation
- ✅ Verify the new pattern works before updating other tests
- ✅ Remove `.only` before committing
- ✅ Run full test suite before completing refactor

## Never

- ❌ Don't update all tests simultaneously
- ❌ Don't leave `.only` in committed code
- ❌ Don't create aliases or backward-compatible signatures to avoid test updates
- ❌ Don't skip running the full test suite before committing

## Example

```typescript
// Step 4: Mark one test with .only
describe.only('New API Pattern', () => {
  it('works with new pattern', async () => {
    // Step 5: Implement new API
    const client = await createClient(stub);
    const result = await client.method();
    expect(result).toBe('expected');
  });
});
```

## Why This Pattern

- **Incremental validation**: Proves new API works before mass updates
- **Fast feedback**: Single test runs faster than full suite
- **Reduces churn**: Catch issues early in one test, not across dozens
- **Clear signal**: `.only` makes it obvious which test is the reference

## Reference

- **Testing rules**: `.cursor/rules/testing.md`
- **Workflow guidelines**: Root `.cursorrules` file

