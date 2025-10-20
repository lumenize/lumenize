# Work In Progress (WIP)

## Current Focus: Performance Benchmarking - @lumenize/rpc vs Cap'n Web

Cloudflare recently released Cap'n Web for browser-to-DO RPC. We need to benchmark @lumenize/rpc against it to understand our competitive position.

### Goal
Prove @lumenize/rpc is competitive with Cap'n Web. If we're in the same ballpark, we win on simplicity and DX. Only optimize if there's a significant performance gap.

### Use Case
Both target the same use case: Browser ↔ Durable Object RPC over HTTP POST and WebSocket.

### Key Insight
**Both use JSON on the wire!**
- Cap'n Web: Preprocessing for Map/Set → `JSON.stringify/parse`
- @lumenize/rpc: `@ungap/structured-clone/json` mode

This makes comparison fair - we're testing similar approaches, not binary vs JSON.

### Metrics

**Bundle Size (Client-side JavaScript)**
- @lumenize/rpc client bundle (KB minified + gzipped)
- Cap'n Web client bundle (KB minified + gzipped)
- *Why it matters*: Affects initial page load, especially on mobile

**Wire Size (Network Payload)**
- Bytes per operation (various test cases)
- Measure for both HTTP and WebSocket
- *Why it matters*: Network bandwidth, mobile data usage

**Latency (Round-trip Time)**
- Cold start: First call (includes connection setup)
- Warm call: Subsequent calls (connection reused)
- Report: median, p90, p99
- *Why it matters*: User-perceived responsiveness

**Throughput (Operations per Second)**
- Sequential: One after another
- Concurrent: N parallel calls
- Report: median, p90, p99
- *Why it matters*: System capacity under load

### Test Operations

**Simple Operations:**
- `increment()`: Minimal payload
- `getString()`: Return a string
- `getNumber()`: Return a number

**Complex Operations:**
- `getComplexObject()`: Nested objects with arrays
- `processArray()`: Large array manipulation
- `handleMap()`: Operations with Map/Set

**Edge Cases:**
- Error throwing and propagation
- Circular references (if applicable)
- Large payloads (stress test)

### Measurement Approach

**Wire Size Measurement:**
- Add consistent 5ms delay per operation
- During delay, measure packet size
- Keeps latency measurements clean

**Statistics:**
- Run each test N times (100? 1000?)
- Calculate median, p90, p99
- Report with confidence intervals

**Environment:**
- Phase 1: Local with split architecture (see below)
- Phase 2: Deployed (if needed for realistic load testing)

**Critical Constraint: Cloudflare Timing Restrictions**
- Cloudflare stops/fuzzes clocks inside Workers/DOs to prevent timing attacks
- Only millisecond granularity (may need microsecond precision)
- **Solution**: Split architecture
  - Server: `wrangler dev` exposes Worker + DO on localhost
  - Client: Regular Node.js measures timing from outside Cloudflare environment
  - Communication: Over localhost HTTP/WebSocket
  - This is different from our usual vitest approach (single-process, in-Workers testing)

### Implementation Plan

**Phase 1: Research & Setup**
- [ ] Study Cap'n Web documentation and examples
- [ ] Create comparison project structure
  - [ ] Worker + DO implementations (runs in `wrangler dev`)
  - [ ] Node.js benchmark client (measures timing externally)
  - [ ] Setup both @lumenize/rpc and Cap'n Web in same project
- [ ] Implement same test DO with both frameworks
- [ ] Verify both implementations work correctly
- [ ] Test split architecture: `wrangler dev` + Node.js client over localhost

**Phase 2: Basic Benchmarks**
- [ ] Bundle size comparison (esbuild with size plugin)
- [ ] Wire size measurement (log bytes in transports)
- [ ] Simple latency tests (increment, getString)
- [ ] Initial results and analysis

**Phase 3: Comprehensive Benchmarks**
- [ ] Complex data structure tests
- [ ] Concurrent operations tests
- [ ] Error handling tests
- [ ] Statistical analysis (p90, p99)

**Phase 4: Documentation**
- [ ] Create BENCHMARKS.md with methodology
- [ ] Document results with charts/tables
- [ ] Identify where each solution excels
- [ ] Recommendations for different use cases

**Phase 5: Optimization (Only if Needed)**
- [ ] Only proceed if Cap'n Web significantly faster
- [ ] Profile and identify actual bottlenecks
- [ ] Consider optimization options (see below)
- [ ] Re-run benchmarks after optimizations

### Potential Optimizations (If Performance Gap Exists)

**Pre/Post Processing Optimizations:**

1. **Unify Object Traversal**
   - Currently: Multiple passes over object graph (circular ref check, function replacement, etc.)
   - Potential: Single-pass traversal doing all processing at once
   - Impact: Reduce redundant object walking

2. **Scope Processing to Payload Only**
   - Currently: Process entire RPC envelope including OperationChain
   - Potential: Only process operation args and results, not metadata
   - Impact: Skip processing fixed structure overhead

3. **Optimize Circular Reference Detection**
   - Currently: Full WeakMap-based cycle detection on every operation
   - Potential: Fast-path for acyclic data (most common case)
   - Impact: Skip expensive checks when not needed

4. **Error Serialization Efficiency**
   - Currently: Full error object serialization with stack traces
   - Potential: Lazy serialization or optional stack trace capture
   - Note: Cap'n Web doesn't support error re-throwing (we do!)

**Capability Trade-offs:**
- @lumenize/rpc currently supports:
  - ✅ Circular reference handling (Cap'n Web: ❌, Cap'n Proto: ✅)
  - ✅ Error re-throwing with stack traces (Cap'n Web: ❌, Cap'n Proto: ❌)
- These add cycles but provide better DX
- May need to make some features optional for performance-critical use cases

**Serialization Alternatives:**

5. **cbor-x (Binary Format)**
   - Pros: Much faster, more compact wire format
   - Cons: Less debuggable, may have incomplete structured clone support
   - Consider: Only if JSON serialization is proven bottleneck

6. **Native JSON with Minimal Preprocessing**
   - Pros: Fastest, zero bundle size
   - Cons: Requires custom Map/Set handling (like Cap'n Web)
   - Consider: Only if @ungap/structured-clone proves slow

**Optimization Strategy:**
1. Benchmark first - identify actual bottleneck
2. Profile specific operations (circular ref check, error serialization, etc.)
3. Implement targeted optimizations
4. Make expensive features optional if needed
5. Document trade-offs clearly

### Success Criteria
- @lumenize/rpc is within 2x of Cap'n Web on key metrics
- Clear documentation of trade-offs (performance vs DX vs capabilities)
- Confidence to recommend @lumenize/rpc for most use cases

### Questions to Answer
- Where does @lumenize/rpc win? (Likely: better structured clone support, DX)
- Where does Cap'n Web win? (Likely: raw performance, official Cloudflare support)
- What's the DX difference? (Setup time, boilerplate, type safety)
- Are there scenarios where one is clearly better?

### Tools & Dependencies
- **wrangler dev**: Expose Worker + DO on localhost
- **Node.js `perf_hooks`**: High-resolution timing (microsecond precision)
- **tinybench** or **Benchmark.js**: For accurate timing in Node.js client
- **esbuild-plugin-size**: Bundle size analysis
- **node-fetch** or **undici**: HTTP client for Node.js
- **ws**: WebSocket client for Node.js
- **k6** or **Artillery**: Load testing (Phase 2, if needed)

### Future Considerations
- Expanding @lumenize/rpc to DO-to-DO and DO-to-Worker
- Alternative serializers (cbor-x) if performance gap exists
- Client-side caching strategies
- Request batching/pipelining

## Later and possibly unrelated

- [ ] Think about how we might recreate the inspect messages functionality we had in @lumenize/testing
- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud (or whatever it's called now. It was previously SonarCloud, I think) account over to the lumenize repo
- [ ] We need much more security info on the website. Maybe an entire .mdx. Here is the completely inadequate warning we had in the README before we thinned it down. 
  ⚠️ **IMPORTANT**: This package exposes your DO internals via RPC endpoints. Only use in development or secure the endpoints appropriately for production use.
- [ ] Test in production on Cloudflare (not just local with vitest)

### GitHub Actions for Publishing & Releases

**Goal**: Automate publishing to npm and creating GitHub releases with changelogs

**Research Completed**: Investigated secure token approaches and GitHub Actions workflow

**Key Findings**:
- **Static tokens being phased out**: npm deprecating TOTP 2FA in favor of rotating keys
- **Modern approach**: GitHub Actions with OIDC (OpenID Connect) - no static tokens needed
- **npm provenance**: Cryptographic proof of package origin, built into modern npm publishing
- **Draft releases**: Can auto-generate release notes, then hand-edit before publishing

**Recommended Workflow**:
1. GitHub Actions triggers on version tags (`v*`)
2. Runs tests, publishes to npm with `--provenance` flag
3. Creates **draft** GitHub release with auto-generated notes from commits/PRs
4. Manual review and editing of release notes
5. Publish release when satisfied

**Only ONE secret needed**: `NPM_TOKEN` (automation token that rotates automatically)
- GitHub authentication handled via built-in `GITHUB_TOKEN` (auto-provided, no setup)
- No static tokens to manage or rotate manually

**Dependencies for Later**:
- Will be implemented when SonarQube Cloud integration is added
- SonarQube scan + unified test coverage reports will use same GitHub Actions infrastructure
- For now, continuing with local `npm run publish` workflow

**Reference Files to Create**:
- `.github/workflows/publish.yml` - Main publish workflow
- `.github/workflows/release.yml` - Release creation workflow (draft mode)

**Benefits of Waiting**:
- Single GitHub Actions setup for both publishing and code quality scanning
- Learn more about team workflow preferences before automating
- Can hand-edit releases via GitHub UI in the meantime (always possible, even after automation)
