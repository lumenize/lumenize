# Mesh Post-Release Improvements (Part 2)

**Status**: Not Started
**Branch**: `feat/mesh-post-release-part-2`

## Objective

Continuation of post-release polish for Lumenize Mesh: working examples and the Gateway pattern blog post. Phases 0–3 were completed in Part 1.

## Phase 4: Working Document Editor Example

**Goal**: A complete, deployable system example that developers can clone and run.

**Success Criteria**:
- [ ] Document editor example works end-to-end (browser ↔ Gateway ↔ DO)
- [ ] Deploy to Cloudflare button (or clear deploy instructions)
- [ ] UI framework decision made and documented
- [ ] Example linked from mesh docs

## Phase 5: Agent Example

**Goal**: At least one example showing how to use Mesh with Cloudflare's Agent pattern.

**Success Criteria**:
- [ ] Working example with `@lumenize/testing` AgentClient
- [ ] Demonstrates a practical use case (not just echo)
- [ ] Linked from mesh docs

## Phase 6: Gateway Pattern Blog Post

**Goal**: Blog post explaining the Gateway pattern with latency benchmarks.

**Success Criteria**:
- [ ] Latency experiments completed:
  - [ ] Direct to DO round trip
  - [ ] Mesh round trip (expect ~+20ms)
  - [ ] Direct to DO → Worker → back to DO → back to client
  - [ ] Mesh three one-way calls (expect comparable to above)
- [ ] Blog post drafted with results and architectural explanation
- [ ] Marked `draft: true` initially, published after review

## Deferred

Items that are important but not in scope for this task file:

- **Rewrite auto-generated TypeDoc pages** — RPC and routing packages have auto-generated API docs from deprecated TypeDoc tooling. These should be rewritten as hand-authored `.mdx` with `@check-example` annotations.
- **Replace doc-testing generated docs** — Several packages still use the deprecated `tooling/doc-testing` plugin to generate `.mdx` from test files (marked with `generated_by: doc-testing` frontmatter). These need to be replaced with hand-written `.mdx` that uses `@check-example` annotations pointing back to the same tests. The `doc-testing` tooling itself is already marked deprecated.

## Notes

- Continued from `tasks/archive/mesh-post-release.md` (Phases 0–3 completed)
- Sourced from `tasks/todos-for-initial-mesh-release.md` "should-have" section and `tasks/mesh-release-website-and-blog.md` deferred items
- Max sub-request limit experiments moved to `tasks/mesh-resilience-testing.md` (was Phase 7) and "could-have" in `todos-for-initial-mesh-release.md`
