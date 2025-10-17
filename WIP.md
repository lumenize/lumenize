# Work In Progress (WIP)

## Current Focus: Create `docusaurus-plugin-check-examples`

A new Docusaurus plugin to verify code examples in hand-written .mdx files match actual test code.

### Problem
- Hand-written docs examples drift from actual code
- Recent example: `getDOStubFromPathname` was renamed to `getDOStub` but docs weren't updated
- Doc-testing works great for comprehensive API docs but is heavyweight for utility snippets

### Solution
- Annotate code blocks with `@check-example(path)` to verify they exist in passing tests
- Lightweight: just checks if code exists, doesn't extract/generate full pages
- Works alongside doc-testing (for comprehensive docs) and check-examples (for snippets)

### Phase 1: Core Plugin (MVP) ✅ COMPLETE
- [x] Create plugin package in `tooling/check-examples/`
  - [x] Package.json with TypeScript, Docusaurus dependencies
  - [x] Basic plugin structure following Docusaurus plugin conventions
  - [x] README explaining usage and design decisions
- [x] Parse .mdx files for annotated code blocks
  - [x] Find code blocks with `@check-example(path)` in first line
  - [x] Extract path and code content
  - [x] Support `@skip-check` annotation to skip verification
- [x] Normalize and match code
  - [x] For TypeScript: strip comments, normalize whitespace
  - [x] For other languages with `strict: true`: exact match
  - [x] Check if normalized doc code exists as substring in test file
- [x] Error reporting
  - [x] Show which .mdx file and line number failed
  - [x] Show expected code and where it should be found
  - [x] Helpful suggestions (renamed function? changed API?)
- [x] Integration with Docusaurus build
  - [x] Automatically runs during `npm run build`
  - [x] Fail build if examples don't match
  - [x] Success/failure summary

### Phase 2: Doc-testing Integration
- [ ] Update doc-testing plugin to add frontmatter to generated files
  - [ ] Add `generated_by: doc-testing` to frontmatter
  - [ ] Document this in doc-testing README
- [ ] Skip check-examples for doc-testing generated files
  - [ ] Check frontmatter before processing
  - [ ] Those files are already verified via actual test execution

### Phase 3: Configuration & Developer Experience
- [ ] Support configuration options
  - [ ] `strict: true` for exact matching (default: false)
  - [ ] Configurable file patterns to check
  - [ ] Exclude patterns
- [ ] Documentation
  - [ ] Create docs page explaining how to use check-examples
  - [ ] Examples of annotation patterns
  - [ ] Migration guide for existing docs

### Phase 4: Coverage (After plugin works)
- [ ] Annotate existing docs files
  - [ ] All code blocks in `website/docs/utils/`
  - [ ] All code blocks in `website/docs/rpc/`
  - [ ] All code blocks in `website/docs/testing/`
- [ ] Create missing test examples where needed
  - [ ] Some docs examples might not have corresponding tests yet
  - [ ] Add lightweight tests to verify example patterns

### Design Decisions (Finalized)
- **Location:** `tooling/check-examples/` (parallel to `tooling/doc-testing/`)
- **Verification Strategy:** **Opt-out (all code blocks checked by default)**
  - High bar: Every code example must match actual working test code
  - Use `@skip-check` only for non-code examples (bash commands, etc.)
  - Path inference: `docs/<package>/<file>.mdx` → `packages/<package>/test/<file>.test.ts`
  - Explicit paths: `@check-example('packages/utils/test/route-do-request.test.ts')`
- **Matching Strategy:** 
  - TypeScript: Normalized (strip comments/whitespace)
  - Other languages: `strict: true` for exact match
  - Default: `strict: false`
- **Annotation Syntax:** 
  - Explicit check: `` ```typescript @check-example('path/to/test.ts') ``
  - Skip check: `` ```bash @skip-check ``
  - Backward compatible: Also supports first-line comment annotations
- **Partial Matches:** Supported - doc example must be substring of test file
- **No Line Numbers:** Tests change frequently, substring search is more resilient
- **Plugin Architecture:** Separate plugin, not part of doc-testing

### Implementation Details (Finalized)
1. **Language Support in Phase 1:** TypeScript/JavaScript only with normalization. Other languages require `strict: true` for exact matching.
2. **Test File Validation:** Trust the developer - don't verify tests are passing. CI will catch failing tests.
3. **Multiple Examples:** Many doc examples can point to the same test file (expected pattern).
4. **Performance:** Cache test file contents during build if easy to implement (avoid premature optimization).
5. **Syntax Variations:** Phase 1 normalizes only whitespace/comments. Smart matching (const vs let vs var) deferred to future phases.

### Success Criteria
- [x] Plugin successfully detects the `getDOStubFromPathname` → `getDOStub` rename issue ✅ Tested and working
- [x] Plugin runs in <5 seconds for all website docs ✅ Completes in ~2ms
- [x] Clear error messages guide developers to fix issues ✅ Shows file, line, code, suggestions
- [x] Zero false positives on current route-do-request.mdx examples ✅ Verified
- [x] Works in CI (build fails if examples drift) ✅ Build fails with clear error on drift

### Phase 1 Results
- **Plugin location**: `tooling/check-examples/`
- **Integration**: Auto-runs in Docusaurus build via `website/docusaurus.config.ts`
- **Performance**: ~2-7ms to check 9 files (0 generated, 9 hand-written)
- **Test coverage**: Successfully catches intentional drift (tested with getDOStubFromPathname)
- **Annotation style**: Fence line annotations (invisible to readers)
  - Basic: `` ```typescript @check-example('packages/utils/test/route-do-request.test.ts') ``
  - Skip: `` ```bash npm2yarn @skip-check ``
  - Backward compatible: Also supports first-line comment annotations
- **Files created**:
  - `tooling/check-examples/package.json`
  - `tooling/check-examples/tsconfig.json`
  - `tooling/check-examples/README.md`
  - `tooling/check-examples/src/index.ts`
- **Files updated**:
  - `website/docusaurus.config.ts` (added plugin)
  - `website/docs/utils/route-do-request.mdx` (annotated examples)

## Later and possibly unrelated

- [ ] Switch all use of 'private' typescript keyword to JavaScript '#'
- [ ] Add a new signature for createRpcClient that's like createTestingClient's
- [ ] Think about how we might recreate the inspect messages functionality we had in @lumenize/testing
- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud (or whatever it's called now. It was previously SonarCloud, I think) account over to the lumenize repo
- [ ] We need much more security info on the website. Maybe an entire .mdx. Here is the completely inadequate warning we had in the README before we thinned it down. 
  ⚠️ **IMPORTANT**: This package exposes your DO internals via RPC endpoints. Only use in development or secure the endpoints appropriately for production use.
- [ ] Possible additional testing for rpc
  - [ ] Add timeout testing to matrix
  - [ ] Add memory leak testing (WebSocket connections)
  - [ ] Test in production on Cloudflare (not just local with vitest)
