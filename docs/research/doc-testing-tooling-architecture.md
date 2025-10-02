# Documentation Testing Tooling - Architecture Plan

**Date**: October 2, 2025  
**Status**: Planning Phase

## Overview

This document outlines the architecture for custom tooling to extract code from documentation and run it as tests.

## Directory Structure

```
lumenize/
├── packages/              # Existing packages
│   ├── rpc/
│   ├── testing/
│   └── utils/
│
├── website/               # Docusaurus site
│   ├── docs/              # Source .mdx files
│   │   ├── intro.mdx
│   │   └── rpc/
│   │       ├── getting-started.mdx
│   │       ├── websocket-guide.mdx
│   │       └── api-reference.mdx
│   │
│   ├── test/
│   │   └── generated/     # Auto-generated test workspaces
│   │       └── rpc/
│   │           ├── getting-started/
│   │           │   ├── src/
│   │           │   │   └── index.ts      # From ```typescript src/index.ts
│   │           │   ├── test/
│   │           │   │   └── example.test.ts  # From ```typescript test
│   │           │   ├── wrangler.jsonc    # From ```jsonc wrangler
│   │           │   └── package.json      # Auto-generated
│   │           │
│   │           └── websocket-guide/
│   │               └── ...
│   │
│   ├── vitest.config.ts   # Vitest config for doc tests
│   └── package.json
│
├── tooling/               # NEW: Custom build tooling
│   ├── package.json       # Dependencies for tooling
│   ├── tsconfig.json      # TypeScript config for tooling
│   ├── README.md          # Overview of all tooling
│   │
│   └── doc-testing/       # Documentation testing tools
│       ├── package.json   # If needs separate dependencies
│       ├── README.md      # Documentation for this tool
│       │
│       ├── src/
│       │   ├── index.ts                  # Main entry point
│       │   ├── types.ts                  # Shared types
│       │   │
│       │   ├── extractor/
│       │   │   ├── remark-plugin-extract.ts   # Remark plugin
│       │   │   ├── code-block-parser.ts       # Parse code blocks
│       │   │   └── handlers/                  # Per-file-type handlers
│       │   │       ├── test-handler.ts        # ```typescript test
│       │   │       ├── wrangler-handler.ts    # ```jsonc wrangler
│       │   │       ├── source-handler.ts      # ```typescript src/...
│       │   │       └── package-handler.ts     # ```json package
│       │   │
│       │   ├── workspace/
│       │   │   ├── workspace-builder.ts       # Build test workspace
│       │   │   ├── package-generator.ts       # Generate package.json
│       │   │   └── file-writer.ts             # Write extracted files
│       │   │
│       │   ├── test-runner/
│       │   │   ├── vitest-executor.ts         # Run vitest
│       │   │   └── result-mapper.ts           # Map results to .mdx
│       │   │
│       │   └── docusaurus/
│       │       ├── plugin.ts                  # Docusaurus plugin
│       │       └── lifecycle-hooks.ts         # Build lifecycle
│       │
│       └── test/
│           ├── fixtures/
│           │   └── sample-doc.mdx         # Test fixtures
│           └── extractor.test.ts          # Unit tests
│
└── scripts/               # Existing lightweight scripts
    └── ...                # Delegate complex logic to tooling/
```

## Core Components

### 1. Remark Plugin (`remark-plugin-extract.ts`)

**Purpose**: Extract code blocks from .mdx files during markdown processing

**Architecture**:
```typescript
interface CodeBlockHandler {
  // Check if this handler applies to a code block
  matches: (language: string, metadata: string) => boolean;
  
  // Extract and process the code block
  extract: (code: string, metadata: string, context: ExtractionContext) => void;
}

interface ExtractionContext {
  // Source document info
  sourceFile: string;
  sourceLine: number;
  
  // Output workspace info
  workspaceDir: string;
  
  // Accumulated files to write
  files: Map<string, FileContent>;
  
  // Dependencies to include in package.json
  dependencies: Set<string>;
}

function remarkPluginExtract(options: PluginOptions) {
  const handlers: CodeBlockHandler[] = [
    new TestHandler(),
    new WranglerHandler(),
    new SourceHandler(),
    new PackageHandler(),
  ];
  
  return (tree: Node, file: VFile) => {
    const context = createContext(file);
    
    // Visit all code blocks in the markdown AST
    visit(tree, 'code', (node) => {
      const { lang, meta, value, position } = node;
      
      // Find matching handler
      for (const handler of handlers) {
        if (handler.matches(lang, meta)) {
          handler.extract(value, meta, {
            ...context,
            sourceLine: position.start.line
          });
          break; // Only one handler per block
        }
      }
    });
    
    // After processing all blocks, write workspace
    writeWorkspace(context);
  };
}
```

### 2. Code Block Handlers

#### Test Handler (`test-handler.ts`)
```typescript
class TestHandler implements CodeBlockHandler {
  matches(lang: string, meta: string): boolean {
    return meta.includes('test');
  }
  
  extract(code: string, meta: string, ctx: ExtractionContext): void {
    // Determine test file path
    const testFile = meta.replace('test', '').trim() || 'extracted.test.ts';
    const testPath = `test/${testFile}`;
    
    // Add to test files (accumulate multiple test blocks)
    ctx.files.set(testPath, {
      content: code,
      append: true, // Multiple test blocks can append
    });
    
    // Parse imports to add to dependencies
    const imports = parseImports(code);
    imports.forEach(pkg => ctx.dependencies.add(pkg));
  }
}
```

#### Wrangler Handler (`wrangler-handler.ts`)
```typescript
class WranglerHandler implements CodeBlockHandler {
  matches(lang: string, meta: string): boolean {
    return meta === 'wrangler' && (lang === 'jsonc' || lang === 'json');
  }
  
  extract(code: string, meta: string, ctx: ExtractionContext): void {
    // Write wrangler.jsonc (only one per workspace)
    ctx.files.set('wrangler.jsonc', {
      content: code,
      append: false,
    });
  }
}
```

#### Source Handler (`source-handler.ts`)
```typescript
class SourceHandler implements CodeBlockHandler {
  matches(lang: string, meta: string): boolean {
    // Metadata is a file path: src/index.ts, src/counter.ts, etc.
    return meta.startsWith('src/') && 
           (lang === 'typescript' || lang === 'javascript');
  }
  
  extract(code: string, meta: string, ctx: ExtractionContext): void {
    // Use metadata as file path
    ctx.files.set(meta, {
      content: code,
      append: false,
    });
    
    // Parse imports for dependencies
    const imports = parseImports(code);
    imports.forEach(pkg => ctx.dependencies.add(pkg));
  }
}
```

### 3. Workspace Builder (`workspace-builder.ts`)

**Purpose**: Create complete test workspace with all necessary files

```typescript
interface WorkspaceStructure {
  baseDir: string;
  files: Map<string, string>;
  dependencies: Set<string>;
}

function buildWorkspace(ctx: ExtractionContext): void {
  // 1. Create directory structure
  ensureDirectories(ctx.workspaceDir, [
    'src',
    'test',
  ]);
  
  // 2. Write all extracted files
  for (const [path, content] of ctx.files) {
    const fullPath = join(ctx.workspaceDir, path);
    if (content.append && existsSync(fullPath)) {
      appendFileSync(fullPath, '\n\n' + content.content);
    } else {
      writeFileSync(fullPath, content.content);
    }
  }
  
  // 3. Generate package.json if not extracted
  if (!ctx.files.has('package.json')) {
    generatePackageJson(ctx);
  }
  
  // 4. Link to monorepo packages (avoid npm install)
  linkMonorepoPackages(ctx);
}
```

### 4. Package Generator (`package-generator.ts`)

**Purpose**: Auto-generate package.json for test workspace

```typescript
function generatePackageJson(ctx: ExtractionContext): void {
  const packageJson = {
    name: `doc-test-${basename(ctx.sourceFile, '.mdx')}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      // Add detected dependencies
      ...Object.fromEntries(
        Array.from(ctx.dependencies).map(pkg => [pkg, 'workspace:*'])
      ),
    },
    devDependencies: {
      '@cloudflare/vitest-pool-workers': '^0.5.27',
      'vitest': '^2.1.8',
      'typescript': '^5.7.3',
    },
  };
  
  const path = join(ctx.workspaceDir, 'package.json');
  writeFileSync(path, JSON.stringify(packageJson, null, 2));
}
```

### 5. Test Runner (`vitest-executor.ts`)

**Purpose**: Execute tests and collect results

```typescript
interface TestResult {
  workspace: string;
  sourceDoc: string;
  passed: boolean;
  failures: TestFailure[];
}

interface TestFailure {
  testName: string;
  errorMessage: string;
  sourceLine?: number; // Line in .mdx where test was defined
}

async function runWorkspaceTests(
  workspaceDir: string,
  sourceDoc: string
): Promise<TestResult> {
  // Run vitest for this workspace
  const result = await execAsync(
    'npx vitest run --reporter=json',
    { cwd: workspaceDir }
  );
  
  // Parse results
  const vitestResult = JSON.parse(result.stdout);
  
  // Map failures back to source .mdx
  const failures = vitestResult.testResults
    .flatMap(r => r.assertionResults)
    .filter(a => a.status === 'failed')
    .map(a => mapFailureToSource(a, sourceDoc));
  
  return {
    workspace: workspaceDir,
    sourceDoc,
    passed: failures.length === 0,
    failures,
  };
}
```

### 6. Docusaurus Plugin (`plugin.ts`)

**Purpose**: Integrate with Docusaurus build lifecycle

```typescript
function docTestPlugin(context, options): Plugin {
  return {
    name: 'docusaurus-plugin-doc-tests',
    
    async loadContent() {
      // Phase 1: Extract all code blocks from .mdx files
      console.log('Extracting code blocks from documentation...');
      await extractAllDocs(context.siteDir);
      
      // Phase 2: Run tests for all workspaces
      console.log('Running documentation tests...');
      const results = await runAllTests();
      
      // Phase 3: Report results
      reportResults(results);
      
      // Phase 4: Fail build if any tests failed
      if (results.some(r => !r.passed)) {
        throw new Error('Documentation tests failed');
      }
      
      return null; // No content to provide
    },
    
    async contentLoaded({ actions }) {
      // No-op, we only care about loadContent
    },
  };
}

export default docTestPlugin;
```

## Code Block Metadata Conventions

### Test Code
```markdown
```typescript test
import { expect } from 'vitest';
// Test code here
```
```

**Extracted to**: `test/extracted.test.ts` (or custom name)

### Test Code (Named)
```markdown
```typescript test:counter.test.ts
import { expect } from 'vitest';
// Test code here
```
```

**Extracted to**: `test/counter.test.ts`

### Source Files
```markdown
```typescript src/index.ts
import { DurableObject } from 'cloudflare:workers';
// Source code here
```
```

**Extracted to**: `src/index.ts`

### Wrangler Configuration
```markdown
```jsonc wrangler
{
  "name": "my-app",
  "main": "src/index.ts"
}
```
```

**Extracted to**: `wrangler.jsonc`

### Package.json (Optional)
```markdown
```json package
{
  "dependencies": {
    "@lumenize/rpc": "workspace:*"
  }
}
```
```

**Extracted to**: `package.json` (overrides auto-generated)

### Skip Testing
```markdown
```typescript test:skip
// This code is shown but not executed
// Useful for intentionally broken examples
```
```

**Behavior**: Displayed in docs, not extracted or tested

## Workflow

### Development Workflow

1. **Write documentation** in `website/docs/rpc/getting-started.mdx`
2. **Mark testable code** with metadata (` ```typescript test`)
3. **Run extraction**: `npm run docs:extract` (in website/)
4. **Run tests**: `npm run docs:test` (or `docs:test:watch`)
5. **Iterate**: Make changes, re-extract, re-test
6. **Build**: `npm run build` (includes extraction + testing)

### NPM Scripts (website/package.json)

```json
{
  "scripts": {
    "docs:extract": "node ../tooling/doc-testing/dist/index.js extract",
    "docs:test": "vitest run test/generated",
    "docs:test:watch": "vitest watch",
    "docs:test:single": "vitest run test/generated/rpc/getting-started",
    "docs:clean": "rm -rf test/generated",
    "build": "npm run docs:extract && npm run docs:test && docusaurus build",
    "start": "docusaurus start"
  }
}
```

### Monorepo Integration

- **Link packages**: Use `workspace:*` protocol in generated package.json
- **Shared config**: Reference root tsconfig.json, vitest.config.ts
- **CI/CD**: Run doc tests as part of monorepo test suite

## Error Handling & Reporting

### Error Types

1. **Extraction errors**: Invalid code block syntax, missing metadata
2. **Test failures**: Assertions fail, runtime errors
3. **Build errors**: TypeScript compilation errors

### Error Messages

```
❌ Documentation test failed in docs/rpc/getting-started.mdx

  Line 45: Test "should increment counter" failed
  
  Expected: 2
  Received: 1
  
  Code block:
  ```typescript test
  expect(counter.value).toBe(2);
  ```
  
  Fix the test or update the documentation.
```

## Benefits

1. **Documentation accuracy**: Code examples are always tested and working
2. **Refactoring confidence**: Breaking changes will fail doc tests
3. **Developer experience**: Copy-paste code from docs actually works
4. **Version sync**: Docs and code stay in sync automatically
5. **Examples as tests**: Real-world usage examples validate the API

## Future Enhancements

1. **Incremental extraction**: Only re-extract changed .mdx files
2. **Parallel testing**: Run doc tests in parallel
3. **Coverage reporting**: Show which docs are tested
4. **Interactive playground**: Live code editor in docs (stretch goal)
5. **Multi-version docs**: Test against multiple package versions

## Open Questions for User Review

1. **Should we create tooling/ as monorepo package or standalone?**
   - Option A: `tooling/doc-testing/` with own package.json
   - Option B: Add to `packages/doc-testing/` as publishable package
   - Recommendation: Option A (internal tooling, not published)

2. **How to handle dependencies in generated package.json?**
   - Option A: Parse imports and auto-detect
   - Option B: Require explicit ` ```json package` block in docs
   - Option C: Use template with common dependencies
   - Recommendation: Option A + Option C fallback

3. **Should extracted workspaces be gitignored?**
   - Yes: `website/test/generated/` should be in .gitignore
   - No risk of committing generated code

4. **Error reporting: Should we halt on first failure or collect all?**
   - Collect all failures and report at end
   - Shows full picture of what needs fixing

5. **Watch mode: Watch .mdx files or extracted tests?**
   - Watch .mdx files, auto-extract and re-run tests
   - Better DX for doc authors
