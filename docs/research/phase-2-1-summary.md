# Phase 2.1 Complete - Proof of Concept

## What We Built

A complete code extraction system that parses .mdx documentation files and generates executable test workspaces.

## Directory Structure Created

```
lumenize/
├── tooling/doc-testing/          # NEW: Doc testing tooling
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md
│   ├── .gitignore
│   ├── src/
│   │   ├── index.ts             # CLI entry point
│   │   ├── types.ts             # Shared types
│   │   ├── utils.ts             # Utilities (parseImports, etc.)
│   │   ├── extractor.ts         # Main extraction logic
│   │   ├── package-generator.ts # Auto-generate package.json
│   │   ├── workspace-builder.ts # Write files to disk
│   │   └── handlers/
│   │       ├── index.ts
│   │       ├── test-handler.ts      # ```typescript test
│   │       ├── wrangler-handler.ts  # ```jsonc wrangler
│   │       ├── source-handler.ts    # ```typescript src/...
│   │       └── package-handler.ts   # ```json package
│   ├── dist/                    # Compiled JavaScript
│   └── test/
│       ├── fixtures/
│       │   └── getting-started.mdx  # Sample doc
│       └── generated/           # Generated test workspaces
│           └── getting-started/
│               ├── src/index.ts
│               ├── test/extracted.test.ts
│               ├── wrangler.jsonc
│               └── package.json
└── docs/research/               # Documentation
    ├── testable-documentation-research.md
    └── doc-testing-tooling-architecture.md
```

## Features Implemented

### 1. Multi-File Type Extraction

The extractor supports all planned file types through a handler pattern:

- **Test code**: ` ```typescript test` → `test/extracted.test.ts`
- **Named tests**: ` ```typescript test:counter.test.ts` → `test/counter.test.ts`
- **Source files**: ` ```typescript src/index.ts` → `src/index.ts`
- **Wrangler config**: ` ```jsonc wrangler` → `wrangler.jsonc`
- **Package.json**: ` ```json package` → `package.json` (optional)
- **Skip testing**: ` ```typescript test:skip` → shown in docs but not extracted

### 2. Smart Dependency Detection

Auto-detects dependencies from import statements:
- Parses `import ... from 'package-name'`
- Handles scoped packages (`@lumenize/rpc`)
- Skips relative imports (`./...`)
- Skips protocol imports (`cloudflare:`, `node:`)
- Uses `workspace:*` for monorepo packages

### 3. Auto-Generated package.json

When no package.json is provided in the .mdx file:
- Creates `package.json` with detected dependencies
- Adds common devDependencies (vitest, TypeScript, etc.)
- Uses `workspace:*` protocol for @lumenize packages
- Sets proper module type and privacy

### 4. CLI Tool

```bash
node dist/index.js extract \
  --docs-dir <input> \
  --output-dir <output> \
  --verbose
```

Features:
- Recursively finds all .mdx/.md files
- Processes each file independently
- Creates per-document test workspaces
- Provides summary (extracted, skipped, failed)
- Verbose mode for debugging
- Exits with error code if any extraction fails

### 5. Error Handling

- Detects duplicate files (multiple wrangler.jsonc blocks)
- Reports errors with file names and line numbers
- Continues processing all files (collects all errors)
- Provides clear error messages

## Example Output

### Input: `getting-started.mdx`

```mdx
## Create Your Durable Object

```typescript src/index.ts
import { lumenizeRpcDo } from '@lumenize/rpc';
import { DurableObject } from 'cloudflare:workers';

class Counter extends DurableObject {
  count = 0;
  increment() {
    this.count++;
    return this.count;
  }
}

export const CounterDO = lumenizeRpcDo(Counter);
```

## Configure Wrangler

```jsonc wrangler
{
  "name": "my-rpc-app",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01"
}
```

## Test It

```typescript test
import { describe, it, expect } from 'vitest';
import { RpcClient } from '@lumenize/rpc';

describe('Counter', () => {
  it('increments', async () => {
    const client = new RpcClient({ ... });
    const counter = client.createProxy();
    const result = await counter.increment();
    expect(result).toBe(1);
  });
});
```
```

### Output: Generated Workspace

```
test/generated/getting-started/
├── src/
│   └── index.ts          # Counter DO class
├── test/
│   └── extracted.test.ts # Test code
├── wrangler.jsonc        # Wrangler config
└── package.json          # Auto-generated with dependencies
```

### Auto-Generated package.json

```json
{
  "name": "doc-test-getting-started",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lumenize/rpc": "workspace:*",
    "vitest": "*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.27",
    "@cloudflare/workers-types": "^4.20241127.0",
    "vitest": "^2.1.8",
    "typescript": "^5.7.3"
  }
}
```

## CLI Output

```
Extracting code blocks from documentation...
  Docs dir: test/fixtures
  Output dir: test/generated

Found 1 documentation files

Processing test/fixtures/getting-started.mdx...
  Found code block: typescript src/index.ts (line 24)
  -> Handled by SourceHandler
  Found code block: jsonc wrangler (line 49)
  -> Handled by WranglerHandler
  Found code block: typescript test (line 70)
  -> Handled by TestHandler
  Wrote 4 files to test/generated/getting-started
✅ getting-started.mdx: 4 files extracted

Summary:
  ✅ Extracted: 1
  ⏭️  Skipped: 0 (no testable code)
  ❌ Failed: 0
```

## Technical Implementation

### Handler Pattern

Each file type has a dedicated handler implementing the `CodeBlockHandler` interface:

```typescript
interface CodeBlockHandler {
  name: string;
  matches: (language: string, metadata: string) => boolean;
  extract: (code: string, metadata: string, line: number, context: ExtractionContext) => void;
}
```

Handlers are processed in order:
1. TestHandler
2. WranglerHandler
3. SourceHandler
4. PackageHandler

First matching handler wins (one handler per code block).

### Markdown Parsing

Uses unified/remark ecosystem:
- `unified` - Text processing framework
- `remark-parse` - Parse markdown to AST
- `remark-frontmatter` - Support YAML frontmatter
- `remark-mdx` - Support MDX syntax
- `unist-util-visit` - Traverse AST nodes

### Import Parsing

Regex-based import detection:
```typescript
/import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g
```

Extracts package name from:
- `import { x } from '@lumenize/rpc'` → `@lumenize/rpc`
- `import x from 'vitest'` → `vitest`
- `import 'package/subpath'` → `package`

## What's Next

### Phase 2.2: Remark Plugin
- Convert extractor to remark plugin
- Integrate with Docusaurus build
- Test extraction during `docusaurus build`

### Phase 2.3: Test Execution
- Create vitest config for website
- Run extracted tests with @cloudflare/vitest-pool-workers
- Report test failures mapped to .mdx files
- Fail build on test failure

### Phase 2.4: Developer Experience
- Add npm scripts to website package
- Document workflow for writing testable docs
- Create more example .mdx files

## Decisions Made

✅ **Root tooling/ directory**: Keeps custom tooling separate from published packages

✅ **Auto-detect dependencies**: Parse imports, fallback to manual package.json if needed

✅ **First-failure approach**: Exit on first error for efficiency

✅ **No watch mode initially**: Can add later if DX requires it

✅ **Gitignore generated workspaces**: test/generated/ not committed

✅ **Visible imports in docs**: Shows users what to import, self-documenting

✅ **Show assertions in docs**: Demonstrates expected behavior

## Files Created

- `tooling/doc-testing/package.json`
- `tooling/doc-testing/tsconfig.json`
- `tooling/doc-testing/README.md`
- `tooling/doc-testing/.gitignore`
- `tooling/doc-testing/src/index.ts` (CLI)
- `tooling/doc-testing/src/types.ts`
- `tooling/doc-testing/src/utils.ts`
- `tooling/doc-testing/src/extractor.ts`
- `tooling/doc-testing/src/package-generator.ts`
- `tooling/doc-testing/src/workspace-builder.ts`
- `tooling/doc-testing/src/handlers/index.ts`
- `tooling/doc-testing/src/handlers/test-handler.ts`
- `tooling/doc-testing/src/handlers/wrangler-handler.ts`
- `tooling/doc-testing/src/handlers/source-handler.ts`
- `tooling/doc-testing/src/handlers/package-handler.ts`
- `tooling/doc-testing/test/fixtures/getting-started.mdx`
- `docs/research/testable-documentation-research.md`
- `docs/research/doc-testing-tooling-architecture.md`

## Status

✅ **Phase 2.1 COMPLETE**

Ready for checkpoint review and approval to proceed to Phase 2.2.
