# @lumenize/doc-testing

Internal tooling for extracting code blocks from documentation and running them as tests.

## Overview

This tool extracts code blocks from `.mdx` documentation files and creates executable test workspaces. It ensures that documentation examples are always accurate and working.

## Architecture

See `../../docs/research/doc-testing-tooling-architecture.md` for detailed architecture.

## Usage

### Extract code from documentation

```bash
npm run build
node dist/index.js extract --docs-dir ../../website/docs --output-dir ../../website/test/generated
```

### Code Block Metadata Conventions

- **Test code**: ` ```typescript test` → `test/extracted.test.ts`
- **Named test**: ` ```typescript test:counter.test.ts` → `test/counter.test.ts`
- **Source files**: ` ```typescript src/index.ts` → `src/index.ts`
- **Wrangler config**: ` ```jsonc wrangler` → `wrangler.jsonc`
- **Package.json**: ` ```json package` → `package.json` (optional, auto-generated otherwise)
- **Skip testing**: ` ```typescript test:skip` → shown in docs but not tested

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Test the extractor itself
npm test
```
