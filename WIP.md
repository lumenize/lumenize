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

### Phase 1: Core Plugin (MVP)
- [ ] Create plugin package in `tooling/check-examples/`
  - [ ] Package.json with TypeScript, Docusaurus dependencies
  - [ ] Basic plugin structure following Docusaurus plugin conventions
  - [ ] README explaining usage and design decisions
- [ ] Parse .mdx files for annotated code blocks
  - [ ] Find code blocks with `@check-example(path)` in first line
  - [ ] Extract path and code content
  - [ ] Support `@skip-check` annotation to skip verification
- [ ] Normalize and match code
  - [ ] For TypeScript: strip comments, normalize whitespace
  - [ ] For other languages with `strict: true`: exact match
  - [ ] Check if normalized doc code exists as substring in test file
- [ ] Error reporting
  - [ ] Show which .mdx file and line number failed
  - [ ] Show expected code and where it should be found
  - [ ] Helpful suggestions (renamed function? changed API?)
- [ ] CLI integration
  - [ ] `npm run check-examples` command
  - [ ] Fail build if examples don't match
  - [ ] Success/failure summary

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
- **Matching Strategy:** 
  - TypeScript: Normalized (strip comments/whitespace)
  - Other languages: `strict: true` for exact match
  - Default: `strict: false`
- **Annotation Syntax:** 
  - `@check-example('path/to/test.ts')` - Basic usage
  - `@check-example('path/to/test.ts', { strict: true })` - Exact matching
  - `@skip-check` - Skip verification (for npm install examples, etc.)
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
- [ ] Plugin successfully detects the `getDOStubFromPathname` → `getDOStub` rename issue
- [ ] Plugin runs in <5 seconds for all website docs
- [ ] Clear error messages guide developers to fix issues
- [ ] Zero false positives on current route-do-request.mdx examples
- [ ] Works in CI (build fails if examples drift)

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
