---
name: coverage-improvement
description: Systematic approach to improving test coverage — categorize uncovered lines, prioritize by effort/value, work one file at a time. Use when coverage needs to be raised for a package.
---

# Coverage Improvement

Raise test coverage systematically by categorizing uncovered lines and working through them in priority order.

## Usage
`/coverage-improvement <package-name>`

## Process

1. Run `npm run coverage` in the package to get the current report
2. Work **one source file at a time**, starting with the lowest-coverage files
3. For each file, categorize every uncovered line/branch into one of:

### Categories

- **Quick Wins** — straightforward to test, meaningful coverage gain (e.g., a public method with no test, a simple branch)
- **Medium Effort** — requires some test setup but is clearly testable (e.g., error paths, reconnection logic)
- **Needs Infrastructure** — requires new test harness, mocking, or fault injection that doesn't exist yet
- **Dead Code** — code with zero callers in the codebase. Don't write tests for dead code — remove it. Speculatively-built infrastructure that was never used (or was replaced by a different approach) should be deleted, not tested. Writing tests for dead code is worse than leaving it uncovered: it creates the illusion that the code is exercised and maintained when no production path depends on it.
- **Defensive / Unreachable** — safety checks that shouldn't execute in normal operation; covering them has diminishing returns
- **Coverage Tool Limitation** — code that executes but istanbul/v8 can't instrument correctly (e.g., Proxy traps)

4. Write tests in priority order: Quick Wins first, then Medium Effort
5. For Needs Infrastructure, note what's needed and decide with the user whether to invest
6. For Defensive/Unreachable and Coverage Tool Limitations, leave uncovered — these are acceptable gaps

## Test Style

**Favor e2e-style tests** (the `test/for-docs/` pattern) over unit tests for coverage — unless the package is a component library or purely algorithmic code.

- For Worker/DO packages like `packages/mesh`, `for-docs` tests that exercise real request flows through the full stack are strongly preferred. The `getting-started.mdx` check-examples work found more bugs than all other testing combined. High unit-test coverage gives false confidence — code that passes per-function tests can fail dramatically at integration.
- For algorithmic/utility packages like `packages/structured-clone`, round-trip echo tests serve the same role — they're effectively e2e for that package even though they aren't `for-docs` style.
- When adding coverage, first ask: "Can I cover this through an existing or new `for-docs` test scenario?" Only fall back to targeted tests when the code path genuinely can't be reached through an e2e flow.

## No Mocking Without Approval

Never use traditional mocking (`vi.mock`, `vi.spyOn`, stub injection, etc.) without explicit human approval.

**Test infrastructure is encouraged instead.** The `@lumenize/testing` package's `Browser` class is the canonical example — it simulates real browser behavior (cookies, CORS, sessionStorage, BroadcastChannel, etc.) so tests exercise actual code paths rather than mocked interfaces. Extending test infrastructure and providing dependency injection capabilities for production code to cover new scenarios (as was done for `LumenizeClient`'s tabId uniqueness) is the ideal approach wherever possible.

## When a Test Fails

**Assume the production code is wrong until you confirm otherwise.** The goal of coverage work is code quality, not coverage numbers. A failing test is a signal — investigate it deeply before changing the test.

- Don't "fix" a test by weakening its assertions or working around production behavior. That defeats the purpose.
- Timing issues, unexpected error types, and missing behavior are often real bugs. Trace the production code path before deciding the test is wrong.
- If the test reveals a genuine production bug, fix the production code. This is the highest-value outcome of coverage work — it proves the coverage effort was worthwhile.
- Only adjust the test if you've confirmed the production code is correct and the test's expectations were wrong.

## Rules
- Never try to cover everything at once — one file, one category at a time
- Quick Wins and Medium Effort should get branch coverage above 80% for most files
- Exclude test infrastructure files (e.g., `test-worker-and-dos.ts`) from coverage metrics — they aren't production code
- Report remaining gaps and their categories when done so the user can make informed decisions

## Targets
- Branch: >80% (target close to 100%)
- Statement: >90%
