# Testable Documentation Research

**Date**: October 2, 2025  
**Goal**: Find or create tooling to extract code from .mdx documentation files and run them as vitest tests

## Requirements Summary

1. **Write narrative documentation** in .md/.mdx files acceptable to Docusaurus
2. **Embed code examples** with imports and vitest assertions (e.g., `expect().toBe()`)
3. **Extract code blocks** automatically from markdown
4. **Run as tests** using vitest with @cloudflare/vitest-pool-workers
5. **Fail build** if any extracted test fails
6. **Rapid iteration** on single documents during development
7. **Decide**: Should imports be in comments or actual code blocks?

## Docusaurus Code Block Features

From official docs (https://docusaurus.io/docs/markdown-features/code-blocks):

### Built-in Features
- **Syntax highlighting** via Prism React Renderer
- **Line highlighting** with comments or metadata strings
- **Line numbering** with `showLineNumbers`
- **Code titles** for file path display
- **Interactive code editor** via `@docusaurus/theme-live-codeblock` (React Live)
  - Adds `live` keyword to code blocks
  - Creates editable playground with live preview
  - Limited to React components
  - NOT suitable for our vitest testing needs

### Plugin System
- **Remark plugins**: Transform markdown during build (e.g., `@docusaurus/remark-plugin-npm2yarn`)
- **Lifecycle hooks**: Custom plugins can hook into build process
- **Code block metadata**: Can add custom attributes to code blocks

## Existing Solutions Analyzed

### 1. React Live (Built into Docusaurus)
**Package**: `@docusaurus/theme-live-codeblock`

**Pros**:
- Already integrated with Docusaurus
- Shows live preview of React components
- Code blocks marked with `live` keyword

**Cons**:
- Only works for React components
- Executes in browser, not Node.js/Workers environment
- Can't use vitest or Cloudflare Workers pool
- Not suitable for testing backend/DO code

**Verdict**: ❌ Not suitable for our needs

### 2. Remark/Rehype Plugin Approach
**Concept**: Write custom remark plugin to extract and test code

**How it works**:
1. Remark plugins transform markdown AST during build
2. Can identify code blocks by language or metadata
3. Extract code and write to test files
4. Run vitest separately or via Docusaurus plugin lifecycle

**Pros**:
- Full control over extraction logic
- Can integrate with Docusaurus build process
- Supports any language/testing framework
- Can use metadata to mark testable blocks (e.g., ` ```ts test`)

**Cons**:
- Need to write custom plugin
- Moderate complexity to implement

**Verdict**: ✅ **Strong candidate** - Most flexible approach

### 3. TypeDoc with Examples
**Package**: `typedoc`, `typedoc-plugin-markdown`

**Pros**:
- Extracts JSDoc from TypeScript
- Can generate markdown for Docusaurus
- `@example` tags in JSDoc can contain code

**Cons**:
- Primarily for API reference, not narrative guides
- Examples in JSDoc are not automatically tested
- Would need separate tooling to extract and test examples
- Not suitable for blog posts or getting started guides

**Verdict**: ⭕ Useful for Phase 1.2 (API docs), not Phase 1.1 (testable guides)

### 4. MDX Test / Doctest Approaches
**Searched for**: mdx-test, markdown-doctest, etc.

**Findings**:
- No mainstream npm packages found specifically for testing MDX code blocks
- Some Python doctest-like tools exist but not for JS/TS
- Would need to build custom solution

**Verdict**: ⭕ No existing tool found, supports custom remark plugin approach

## Recommended Approach

### Solution: Custom Remark Plugin + Vitest Integration

#### Phase 2.1: Proof of Concept

**Step 1**: Create sample .mdx file in `lumenize/website/docs/rpc/`

```mdx
---
title: Getting Started with @lumenize/rpc
---

# Getting Started

@lumenize/rpc allows you to create RPC endpoints on Cloudflare Durable Objects.

## Installation

```bash npm2yarn
npm install @lumenize/rpc
```

## Basic Usage

Create a simple Durable Object with RPC endpoint:

```typescript test
import { lumenizeRpcDo } from '@lumenize/rpc';
import { DurableObject } from 'cloudflare:workers';
import { expect } from 'vitest';

class Counter extends DurableObject {
  count = 0;
  increment() {
    this.count++;
    return this.count;
  }
}

const CounterWithRpc = lumenizeRpcDo(Counter);

// Test it works
const instance = new CounterWithRpc({} as any, {} as any);
const result = await instance.increment();
expect(result).toBe(1);
```

The counter increments and returns the new value.
```

**Step 2**: Create extraction script `scripts/extract-doc-tests.js`

```javascript
// Parse all .mdx files in docs/
// Find code blocks with `test` metadata
// Extract code including imports
// Write to test/generated/doc-tests/*.test.ts
// Wrap with necessary boilerplate
```

**Step 3**: Configure vitest to run generated tests

```typescript
// vitest.config.js for website
export default {
  test: {
    include: ['test/generated/doc-tests/**/*.test.ts'],
    pool: '@cloudflare/vitest-pool-workers',
    // ... cloudflare config
  }
}
```

**Step 4**: Create npm scripts

```json
{
  "scripts": {
    "docs:extract-tests": "node scripts/extract-doc-tests.js",
    "docs:test": "npm run docs:extract-tests && vitest run",
    "docs:test:watch": "vitest watch test/generated/doc-tests/getting-started.test.ts"
  }
}
```

#### Phase 2.2: Docusaurus Integration

**Option A**: Pre-build hook
```typescript
// In docusaurus.config.ts
plugins: [
  function docTestPlugin(context, options) {
    return {
      name: 'docusaurus-plugin-doc-tests',
      async loadContent() {
        // Run: npm run docs:extract-tests
        // Run: vitest run
        // Throw if tests fail
      }
    }
  }
]
```

**Option B**: Custom build script
```json
{
  "scripts": {
    "build": "npm run docs:test && docusaurus build"
  }
}
```

## Design Decisions

### Decision 1: How to mark testable code blocks?

**Options**:
1. Metadata flag: ` ```typescript test`
2. Special comment: `// @doctest` inside code block
3. All TypeScript blocks auto-tested
4. File-based: Separate test files referenced in docs

**Recommendation**: **Option 1** - Metadata flag with extension for file extraction
- Clean and explicit
- Easy to parse in remark plugin
- Doesn't clutter visible code
- Can add variants:
  - ` ```typescript test` - Extract and run as test
  - ` ```jsonc wrangler` - Extract as wrangler.jsonc
  - ` ```typescript src/index.ts` - Extract as source file
  - ` ```typescript test:skip` - Show but don't test (for broken examples)

### Decision 2: Where should imports go?

**Options**:
1. In visible code blocks (part of docs)
2. In HTML comments (hidden from readers)
3. In YAML frontmatter per-document
4. Inferred/auto-injected by test framework

**Recommendation**: **Option 1** - Visible imports
- Shows users what they need to import
- Self-documenting
- No magic/hidden dependencies
- Code blocks are complete and copy-pasteable

### Decision 3: How to handle test-only code?

For assertions like `expect(result).toBe(1)`:

**Options**:
1. Show them in docs (educational)
2. Hide them with special syntax
3. Split example and test code

**Recommendation**: **Option 1** - Show assertions
- Demonstrates expected behavior
- Acts as live documentation
- Shows readers how to verify their implementation

Alternative for prose-heavy guides: Use `typescript test:hidden` metadata to run tests without showing them in rendered docs.

## Implementation Plan

### Phase 2.1: POC (Estimated: 6-8 hours)
1. ✅ Research complete
2. Create `tooling/doc-testing/` directory structure
3. Write basic extraction script supporting:
   - ` ```typescript test` → test files
   - ` ```jsonc wrangler` → wrangler.jsonc
   - ` ```typescript src/index.ts` → source files
4. Create sample .mdx with all file types
5. Generate test workspace and verify vitest runs it
6. Test with @cloudflare/vitest-pool-workers

### Phase 2.2: Remark Plugin (Estimated: 4-5 hours)
1. Convert extraction script to remark plugin
2. Add to docusaurus.config.ts remarkPlugins
3. Test extraction during Docusaurus build
4. Verify all file types extracted correctly

### Phase 2.3: Test Execution Integration (Estimated: 3-4 hours)
1. Create Docusaurus plugin for test execution
2. Run extracted tests during build
3. Add proper error reporting (map to .mdx line numbers)
4. Fail build on test failure

### Phase 2.4: Developer Experience (Estimated: 2-3 hours)
1. Create watch mode for single doc iteration
2. Add npm scripts for common workflows
3. Document how to write testable docs
4. Create examples for common patterns

## Open Questions

1. **Should we suppress console.log in extracted tests?** 
   - Probably yes, unless debugging
   
2. **How to handle async setup/teardown?**
   - Use vitest's beforeAll/afterAll in generated files
   
3. **Should imports be de-duplicated across blocks in same file?**
   - Yes - extract all imports, place at top of generated test file
   
4. **How to handle code blocks that shouldn't be tested but should be shown?**
   - Default: don't test unless marked with `test` metadata
   
5. **Error reporting: which line in .mdx failed?**
   - Parse vitest output, map back to source .mdx line numbers

## Project Organization

### Extracting Multiple File Types

Documentation will need to show complete project setups, including:
- **Test files**: ` ```typescript test`
- **Configuration files**: ` ```jsonc wrangler`, ` ```json package.json`
- **Source files**: ` ```typescript src/index.ts`
- **Environment files**: ` ```bash .env`

### Proposed Directory Structure

```
lumenize/
├── packages/
│   └── rpc/
├── website/
│   ├── docs/           # Documentation .mdx files
│   └── test/
│       └── generated/  # Auto-generated test workspace per doc
│           ├── getting-started/
│           │   ├── src/
│           │   │   └── index.ts      # Extracted from ```typescript src/index.ts
│           │   ├── test/
│           │   │   └── example.test.ts  # Extracted from ```typescript test
│           │   ├── wrangler.jsonc    # Extracted from ```jsonc wrangler
│           │   └── package.json      # Generated or extracted
│           └── websocket-guide/
│               └── ...
├── tooling/            # NEW: Custom build tooling
│   ├── package.json
│   ├── tsconfig.json
│   └── doc-testing/
│       ├── README.md
│       ├── src/
│       │   ├── extract-doc-tests.ts       # Main extraction script
│       │   ├── remark-plugin-extract.ts   # Remark plugin
│       │   ├── code-block-extractor.ts    # Core extraction logic
│       │   └── test-workspace-builder.ts  # Build test workspace structure
│       └── test/
│           └── extractor.test.ts          # Test the extractor itself
└── scripts/            # Existing scripts directory
    └── (keep lightweight, delegate to tooling/)
```

### Single Plugin vs Multiple Plugins?

**Question**: Do we need separate remark plugins for each file type?

**Answer**: **No** - Single plugin with multiple extractors

**Rationale**:
- All extraction happens in one pass over the markdown AST
- Different code blocks need to be extracted to different locations in the same test workspace
- Coordination required (e.g., test files need to import from extracted src files)

### Architecture: Single Remark Plugin with Multiple Handlers

```typescript
// tooling/doc-testing/src/remark-plugin-extract.ts

interface CodeBlockHandler {
  matches: (lang: string, meta: string) => boolean;
  extract: (code: string, meta: string, context: ExtractionContext) => void;
}

const handlers: CodeBlockHandler[] = [
  {
    matches: (lang, meta) => meta.includes('test'),
    extract: (code, meta, ctx) => {
      // Add to test file
      ctx.testCode.push(code);
    }
  },
  {
    matches: (lang, meta) => meta === 'wrangler',
    extract: (code, meta, ctx) => {
      // Write wrangler.jsonc
      ctx.files['wrangler.jsonc'] = code;
    }
  },
  {
    matches: (lang, meta) => meta.startsWith('src/'),
    extract: (code, meta, ctx) => {
      // Extract file path from metadata
      const filePath = meta;
      ctx.files[filePath] = code;
    }
  }
];

function remarkPluginExtract() {
  return (tree, file) => {
    const ctx = createExtractionContext(file.path);
    
    visit(tree, 'code', (node) => {
      for (const handler of handlers) {
        if (handler.matches(node.lang, node.meta)) {
          handler.extract(node.value, node.meta, ctx);
        }
      }
    });
    
    // Write all extracted files
    writeTestWorkspace(ctx);
  };
}
```

### Extraction Strategy

**Per-document workspace**: Each .mdx file gets its own test workspace

**Example**: `docs/rpc/getting-started.mdx` generates:
```
website/test/generated/rpc/getting-started/
├── src/
│   └── index.ts
├── test/
│   └── getting-started.test.ts
├── wrangler.jsonc
└── package.json (auto-generated or extracted)
```

**Benefits**:
- Each doc is self-contained and testable
- Can run tests for single doc: `vitest run test/generated/rpc/getting-started`
- Clear mapping from doc to test workspace
- No conflicts between different guides

### Code Block Metadata Convention

```markdown
# Getting Started

## Setup Configuration

```jsonc wrangler
{
  "name": "my-rpc-app",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01"
}
```

## Create Your Durable Object

```typescript src/index.ts
import { lumenizeRpcDo } from '@lumenize/rpc';
import { DurableObject } from 'cloudflare:workers';

class Counter extends DurableObject {
  count = 0;
  increment() { return ++this.count; }
}

export const CounterDO = lumenizeRpcDo(Counter);
```

## Test It Works

```typescript test
import { describe, it, expect } from 'vitest';
import { CounterDO } from '../src/index';

describe('Counter RPC', () => {
  it('increments correctly', async () => {
    // Test implementation
  });
});
```
```

### Metadata Patterns

- **Tests**: ` ```typescript test` or ` ```javascript test`
- **Wrangler config**: ` ```jsonc wrangler`
- **Source files**: ` ```typescript src/index.ts` (path as metadata)
- **Package.json**: ` ```json package` (auto-generate dependencies if needed)
- **Skip testing**: ` ```typescript test:skip` (show but don't run)

### Test Execution Strategy

1. **Extract phase**: During Docusaurus build (or pre-build)
   - Parse all .mdx files
   - Extract code blocks to test workspaces
   - Generate package.json for each workspace if needed

2. **Test phase**: After extraction
   - Run vitest with proper config for each workspace
   - Use @cloudflare/vitest-pool-workers where needed
   - Collect results across all doc tests

3. **Report phase**: After tests
   - Map test failures back to source .mdx files
   - Display helpful error messages with line numbers
   - Fail Docusaurus build if any test fails

### Implementation Phases

**Phase 2.1**: POC with single plugin
- Extract tests and wrangler.jsonc from one .mdx file
- Generate test workspace
- Run vitest and verify it works

**Phase 2.2**: Multiple file types
- Add handlers for src files, package.json, etc.
- Test with realistic multi-file example

**Phase 2.3**: Integration
- Convert to remark plugin
- Integrate with Docusaurus build
- Add error reporting

**Phase 2.4**: Developer experience
- Watch mode for single doc
- Better error messages
- Documentation for writing testable docs

## Open Questions (Updated)

## References

- Docusaurus Code Blocks: https://docusaurus.io/docs/markdown-features/code-blocks
- Docusaurus Plugin API: https://docusaurus.io/docs/api/plugins
- Remark Plugins: https://github.com/remarkjs/remark/blob/main/doc/plugins.md
- React Docs (similar pattern): https://react.dev/learn (uses live code playgrounds)
- Rust Book Testing: https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html

## Next Steps

1. **Create proof-of-concept** .mdx file
2. **Write extraction script** (simplest version)
3. **Verify tests run** with vitest + workers pool
4. **Demo to user** and get feedback
5. **Refine approach** based on learnings
6. **Build remark plugin** for production use
