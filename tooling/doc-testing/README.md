# @lumenize/doc-testing

Docusaurus plugin for generating documentation from test files. This flips the traditional doc-testing approach: instead of extracting code from documentation, it extracts Markdown from working test files.

## Philosophy

- **Tests as source of truth**: Your actual working tests are the documentation source
- **Always in sync**: When tests break, documentation becomes invalid
- **Fast iteration**: Edit tests directly with full IDE support and type checking
- **No extraction brittleness**: Documentation is generated during build, not extracted into test workspaces

## How It Works

1. Write test files with Markdown in `/* */` block comments
2. Use `@import` directives to include external files (config, source files, etc.)
3. Reference test files in `sidebars.ts` with special comments
4. Plugin generates virtual `.mdx` files during Docusaurus build
5. Generated docs include the "📘 Doc-testing" notice automatically

## Usage

### 1. Write Tests with Embedded Markdown

```typescript
/*
# Usage Guide

This is the intro to your documentation.
*/

import { it, expect } from 'vitest';

it('shows basic usage', () => {
  expect(1 + 1).toBe(2);
});

/*
## Advanced Usage

More documentation here...
*/

it('shows advanced usage', () => {
  // More test code
});
```

### 2. Use @import Directives

```typescript
/*
## Configuration

Here's the configuration file:

@import {typescript} "../src/config.ts" [src/config.ts]

The syntax is:
- `{language}` - Code fence language
- `"path"` - File path relative to the test file
- `[displayName]` - Optional display name shown in code fence
*/
```

### 3. Reference in Sidebars

In your `sidebars.ts`, use `customProps.docTest` to specify the test file:

```typescript
{
  type: 'category',
  label: 'Testing',
  items: [
    {
      type: 'doc',
      id: 'testing/usage',
      customProps: {
        docTest: 'doc-test/testing/testing-plain-do/test/usage.test.ts'
      }
    },
  ],
}
```

The plugin generates `testing/usage.mdx` which should be committed to git (like TypeDoc API docs).
```

### 4. Configure Plugin

In `docusaurus.config.ts`:

```typescript
import { docTestPlugin } from '@lumenize/doc-testing';

const config = {
  plugins: [
    [docTestPlugin, { verbose: true, injectNotice: true }],
  ],
};

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Test the extractor itself
npm test
```
