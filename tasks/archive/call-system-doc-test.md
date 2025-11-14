# Call System Doc-Test

**Status**: Active
**Started**: 2025-11-13

## Goal

Create a doc-test for the call system to explore and document the API through working executable examples.

## Why Doc-Test First?

- **Learn by doing**: Write narrative + working code together
- **Immediate feedback**: Test as you write, no waiting for build
- **API validation**: Discover issues in real usage patterns
- **Documentation output**: Auto-generates docs from working examples
- **Pedagogical**: Teaches the API through progressive examples

## What We'll Discover

1. How `$result` markers actually work
2. Error handling patterns
3. Multiple in-flight calls
4. Timeout behavior
5. FIFO ordering guarantees
6. Whether docs match reality

## Setup

Create new doc-test workspace at: `/doc-test/call/basic-usage/`

### File Structure
```
doc-test/call/basic-usage/
├── package.json
├── tsconfig.json
├── vitest.config.js
├── wrangler.jsonc
├── src/
│   └── index.ts          # Test DOs
└── test/
    └── usage.test.ts      # Doc-test with markdown + examples
```

## Doc-Test Content Plan

### 1. Basic Call (Simple)
```typescript
/*
# Call System Usage

The call system enables DO-to-DO communication with automatic result delivery.

## Basic Usage

Call a remote DO and handle the result:
*/

it('basic call with result handler', async () => {
  // Setup caller and callee DOs
  const caller = /* ... */;
  const callee = /* ... */;
  
  // Make a call with continuation
  await caller.callRemote();
  
  // Verify result delivered
  // ...
});
```

### 2. Multiple Calls (The $result Mystery)
```typescript
/*
## Multiple Calls

How does `this.ctn().$result` distinguish between multiple in-flight calls?
*/

it('multiple simultaneous calls', async () => {
  // Fire off 3 calls at once
  // Verify each gets correct result
  // Understand marker system
});
```

### 3. Error Handling
```typescript
/*
## Error Handling

When remote call fails, how is error delivered?
*/

it('handles remote errors', async () => {
  // Call that throws
  // Verify error arrives at continuation
  // Check error format
});
```

### 4. Timeouts
```typescript
/*
## Timeouts

What happens when call takes too long?
*/

it('handles timeouts', async () => {
  // Call that never returns
  // Verify timeout fires
  // Check error format
});
```

### 5. FIFO Ordering
```typescript
/*
## Ordering Guarantees

Multiple calls should be processed in order.
*/

it('maintains FIFO order', async () => {
  // Queue 5 calls
  // Verify results arrive in order
});
```

## Steps

- [ ] **1**: Create doc-test workspace structure
  - Copy from existing doc-test (e.g., `/doc-test/rpc/quick-start/`)
  - Update package.json dependencies
  - Create basic wrangler.jsonc with two DOs (caller, callee)

- [ ] **2**: Write basic call example
  - Simple caller DO that makes one call
  - Simple callee DO that returns data
  - Verify basic flow works

- [ ] **3**: Explore `$result` markers
  - Try multiple calls at once
  - Document how they're distinguished
  - Update understanding of API

- [ ] **4**: Test error handling
  - Callee throws error
  - Document error delivery pattern
  - Verify against docs

- [ ] **5**: Test timeouts
  - Callee never responds
  - Document timeout behavior
  - Check if timeout implemented yet

- [ ] **6**: Test FIFO ordering
  - Queue multiple calls
  - Verify order maintained
  - Document guarantees

- [ ] **7**: Add to website
  - Reference in `website/sidebars.ts`
  - Generate `.mdx` file
  - Review generated documentation

## Success Criteria

- [ ] Doc-test runs and passes
- [ ] All API patterns understood and documented
- [ ] `$result` marker mystery solved
- [ ] Error handling pattern clear
- [ ] Generated docs are pedagogical and clear
- [ ] Ready to return to hardening task with confidence

## Notes

- **Pattern**: Follow existing doc-tests in `/doc-test/rpc/`
- **Testing**: Use `@lumenize/testing` helpers for DO testing
- **Narrative**: Write for someone learning the API, not just testing it
- **Iteration**: Fast feedback loop - edit test, run, learn, repeat

## After This Task

Return to `/tasks/durable-queuing-system.md` Phase 0 armed with:
- Complete understanding of call API
- Verified error handling patterns
- Knowledge of continuation signatures
- Confidence to implement hardening

