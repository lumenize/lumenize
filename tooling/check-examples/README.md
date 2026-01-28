# @lumenize/docusaurus-plugin-check-examples

A Docusaurus plugin that verifies code examples in hand-written `.mdx` files match actual test code.

## Problem

Documentation examples drift from actual code over time:
- Functions get renamed (e.g., `getDOStubFromPathname` → `getDOStub`)
- APIs change but docs aren't updated
- Examples work initially but break silently

## Solution

Annotate code blocks to verify they exist in passing tests. Annotations go on the fence line (invisible to readers):

```mdx
```typescript @check-example('packages/utils/test/route-do-request.test.ts')
import { routeDORequest } from '@lumenize/utils';

const response = await routeDORequest(env.MY_DO, request);
\```
```

The plugin will:
1. Extract the code from your documentation
2. Read the referenced test file
3. Normalize both (strip comments/whitespace)
4. Verify the doc code exists as a substring in the test file
5. Fail the build with helpful errors if not found

## Implementation

Written in JavaScript with JSDoc type annotations - **no build step required**. The plugin runs directly from source, eliminating build cache issues and simplifying development.

## Usage

### 1. Install

```bash
npm install --save-dev @lumenize/docusaurus-plugin-check-examples
```

### 2. Add to docusaurus.config.ts

```typescript
export default {
  plugins: [
    '@lumenize/docusaurus-plugin-check-examples',
  ],
};
```

### 3. Annotate code blocks

Add `@check-example(path)` to the opening fence line of code blocks you want to verify:

```mdx
```typescript @check-example('packages/utils/test/route-do-request.test.ts')
const response = await routeDORequest(env.MY_DO, request);
\```
```

You can also put it as a comment on the first line of the code block (for backward compatibility):

```mdx
```typescript
// @check-example('packages/utils/test/route-do-request.test.ts')
const response = await routeDORequest(env.MY_DO, request);
\```
```

### 4. Auto-skipped languages

The following languages are automatically skipped without needing any annotation:

- **Shell:** `bash`, `sh`, `shell`, `zsh`
- **Diagrams:** `mermaid`
- **Data formats:** `json`, `jsonc`, `yaml`, `yml`, `toml`, `ini`, `csv`
- **Other:** `text`, `txt`, `plain`, `diff`, `markdown`, `md`, `sql`, `graphql`, `gql`

These blocks are non-executable or configuration snippets that don't need verification.

### 5. Ellipsis wildcards

Use `// ...` or `/* ... */` in your doc examples to skip over intervening code. This allows you to show the important parts of a snippet while omitting boilerplate:

```mdx
```typescript @check-example('packages/mesh/src/types.ts')
interface CallContext {
  callChain: NodeIdentity[];
  // ...
  state: Record<string, unknown>;
}
\```
```

The plugin converts ellipsis markers to regex wildcards (`.*?`), so the above will match any `CallContext` interface that has `callChain` and `state` properties, even if there are other properties in between.

This works in JSON/JSONC blocks too:

```mdx
```jsonc @check-example('wrangler.jsonc')
{
  "name": "my-worker",
  // ...
  "compatibility_date": "2025-09-12"
}
\```
```

### 6. Skip verification for specific blocks

For TypeScript/JavaScript examples that shouldn't be verified (e.g., conceptual snippets), use `@skip-check-approved` with a reason:

```mdx
```typescript @skip-check-approved('conceptual')
@mesh()                       // Basic entry point
@mesh(guardFunction)          // With access control guard
\```
```

The `@skip-check` annotation (without `-approved`) is available for work-in-progress, but should be converted to either `@check-example` or `@skip-check-approved('reason')` before publishing.

### 7. Report mode

To audit skip annotations across all docs:

```bash
node tooling/check-examples/src/index.js --report
```

This shows a summary of all `@skip-check` (pending) and `@skip-check-approved` (approved) annotations, sorted by count. Use this to track progress converting examples to verified ones.

## Design Decisions

### Normalized Matching (Default)
- TypeScript/JavaScript: Strips imports, comments, type parameters, and normalizes whitespace
- JSON/JSONC: Strips comments and normalizes whitespace
- Allows minor formatting differences between docs and tests
- Doc code must exist as substring in test file (after normalization)

### Strict Matching (Opt-in)
```mdx
```python
# @check-example('test/example.py', { strict: true })
def hello():
    return "world"
\```
```

### Why Substring Matching?
- Tests are comprehensive, docs show focused snippets
- Doc examples are extracted from larger test contexts
- More resilient than line-number-based matching (tests change frequently)

### Supported Languages
- **TypeScript/JavaScript:** Normalization with ellipsis wildcards
- **JSON/JSONC:** Normalization with ellipsis wildcards
- **Auto-skipped:** bash, mermaid, yaml, etc. (see list above)
- **Other languages:** Require `strict: true` for exact matching

## How It Works

1. **Build-time scanning:** Plugin runs during Docusaurus build
2. **Parse .mdx files:** Extract annotated code blocks
3. **Skip auto-skip languages:** bash, mermaid, json, etc. need no annotation
4. **Normalize code:** Strip comments, collapse whitespace (TypeScript/JS/JSON only)
5. **Handle ellipsis:** Convert `// ...` to regex wildcards
6. **Substring search:** Check if doc code exists in test file
7. **Clear errors:** Show file, line, expected code, helpful suggestions

## Integration with doc-testing

This plugin is complementary to `@lumenize/docusaurus-plugin-doc-testing`:

- **doc-testing**: Generates comprehensive API docs by executing tests
- **check-examples**: Verifies hand-written snippet examples match tests

Files generated by doc-testing are automatically skipped (they have `generated_by: doc-testing` in frontmatter).

## Error Messages

When verification fails:

```
❌ Example verification failed in website/docs/utils/route-do-request.mdx:42

Expected code not found in packages/utils/test/route-do-request.test.ts:
  const response = await getDOStubFromPathname(env.MY_DO, request);

Possible issues:
- Function renamed? Check test file for similar patterns
- API changed? Update example to match current implementation
- Test file moved? Update @check-example path
```

## Performance

- Caches test file contents during build
- Target: <5 seconds for all website docs
- Auto-skipped languages have zero overhead
- Runs only on .mdx files with annotations

## License

MIT
