# Proxy-Fetch Performance Experiment Results

**Date**: 2025-11-21

**Methodology**:
- **In production**: Tests run in production from Raleigh, NC. DOs, Workers, and test endpoints all likely running in the same east coast data center
- **Wall clock billing**: Wrangler tail log capture with response. Tail log contains entries indicating wall clock billing, although the wall clock billing per op was less than the delay programmed into the endpoint. We believe this is because the async reading of the response body interleaves with start of the next fetch.
- **Latency**: Since clocks are unreliable in Cloudflare environments, those measurements are made in a node.js client. The client establishes a WebSocket connection into the test environment in Cloudflare and when tests run, it pushes start/end events down the wire to the node.js client which captures the time they arrive. Multiple runs smooth out variance in one-way WebSocket message passing.

**Test Strategy**: 5 runs of 6 operations each, then averaged
- **Why 6 operations**: Cloudflare queues requests after 6 simultaneous. While the conditions were coded to not start the next request until the prior one completes, we chose 6 to avoid the possibilitily of queuing. In the end, that was probably not necessary.
- **Why multiple runs**: Reduces measurement variance

## Executive Summary

ProxyFetch adds minimal extra latency and demonstrates significant wall clock savings. However, that is more than eaten up by the extra costs associated the architecture until the average request length exceeds 1.4 seconds.

## Performance Comparison Tables

### Latency Overhead

| Endpoint | Fetch Duration | Direct Latency | ProxyFetch Latency | **Overhead** |
|----------|---------------|----------------|-------------------|--------------|
| `/uuid` | ~0ms | 74.03ms/op | 108.47ms/op | **+34.44ms (46.5%)** |
| `/delay/100` | 100ms | 162.17ms/op | 181.44ms/op | **+19.27ms (11.9%)** |
| `/delay/1000` | 1000ms | 1,083.40ms/op | 1,089.87ms/op | **+6.47ms (0.6%)** |

### Cost Savings (Billing)

| Endpoint | Endpoint Time | Direct Wall Time | ProxyFetch DO Wall Time | ProxyFetch Worker CPU Time |
|----------|---------------|------------------|-------------------------|---------------------------|
| `/uuid` | ~0ms | 47ms | 32ms (15ms less) | 13ms |
| `/delay/100` | 100ms | 98ms | 29ms (68ms less) | 14ms |
| `/delay/1000` | 1000ms | 777ms | 30ms (747ms less) | 12ms |

If the only thing involved was wall clock time, we could just say that it's a 96% savings to use proxy-fetch over direct, but that's not all that's involved. The proxy-fetch condition costs more than the direct condition in the following ways:

- **Addtional CPU time**: The Worker in proxy-fetch spends about 13ms CPU time. Seems like a lot but that's what the data shows.

- **Chargeable requests**: "Cloudflare does not bill for subrequests you make from your Worker." It's unclear if you can mix request types. If you can, then they both have the same number of requests and all that happen after that are subrequests for both conditions. That means the proxy-fetch condition has 0 additional requests. However, I think that is unlikely, which means that the incoming request from the origin DO to the Worker and the incoming request from the Worker to the DO are both billable. So, there is 1 additional Worker request and 1 additional DO request for the proxy-fetch condition.

- **Rows written**: The proxy-fetch condition uses storage to keep track of the pending request to implement timeout Erroring. That's at least 1 row written (could be more considering index writes). Let's assume it's 1 for now.

- **Rows read**: It also has at least 1 row read.

Just to make the math reasonable, we're going to assume we're talking about high volume, well above the included amounts for any of the below charges, so I'm going to only use the numbers for "additional" in this calculation.

**Workers**
- $0.02 per million CPU milliseconds
- $0.30 per million requests

**Durable Objects**
- $12.50 per million GB-s. Assuming 128MB per DO, that translates to:
  - $12.50 * 128 / 1,000 / 1,000,000 = $0.0016 per million wall clock milliseconds
- $0.15 per million requests
- $1.00 per million rows written
- $0.001 / million rows read

So, the cost savings when using proxy-fetch for 1M 1000ms operations is:
- 747 * $0.0016 = $1.20 in reduced wall clock charges
- Total: $1.20 in savings

The extra cost when using proxy-fetch for 1M 1000ms operations is:
- 12 * $0.02 = $0.24 in addtional CPU charges
- 1 * $0.30 = $0.30 in additional Worker requests
- 1 * $0.15 = $0.15 in additional DO requests
- 1 * $1.00 = $1.00 in storage rows written
- 1 * 0.001 = $0.001 in storage rows read
- Total:  $1.691 in extra costs

So, even giving the benefit of the doubt on requests and only needing one row written and one row read, it costs you ~$0.50 more per million operations to use proxy-fetch. The storage writes are the big reason.

However, if you have 10 second requests (not unreasonable with agentic AI workloads), then there are cost savings of about $10 per million operations.

If we built a version of proxy-fetch without the timeout feature, you'd save ~$0.50 per million operations of 1 second requests and ~$11 per million operations for 10 second requests, but it would still cost you ~$1.50 more for 100ms and ~$1.60 more for requests where there is no processing time needed by the remote API, like when retrieving a static asset. It might make sense to build this, because you'd still get fetch timeouts. You'd just not hear anything back if one of the two RPC calls failed or if the Worker died for some reason.

Altneratively/additionally, we could also build a version of "proxy"-fetch that did direct calls from the DO (but then the name wouldn't make sense because there is no actual proxying). It won't cost anything and you's get the better DX.

## Methodology

### Measurement Approach

**Latency (Client-side):**
- Measured on Node.js client using `Date.now()` (where time actually advances)
- Captures total request time from DO perspective
- Measured via WebSocket events: `timing-start` to `timing-end`

**Billing (Cloudflare logs):**
- Extracted from `wrangler tail --format json` logs
- Real-time capture during experiments
- Filters logs by time window and entrypoint/executionModel
- Separates DO wall time (billed) from Worker wall time (not billed, only CPU billed)

### Response Body Consumption

**Critical fix applied:**
- Direct approach: Consumes response body with `await response.json()` to ensure full fetch completion
- ProxyFetch approach: Response body consumed in Worker via `ResponseSync.fromResponse()`, then accessed in alarm handler via `response.json()` (synchronous)

**Why this matters:**
- Without consuming the body, `fetch()` returns when headers arrive, not when full response completes
- This would cause incorrect billing measurements (DO returns early)
- All tests include proper body consumption

### Test Endpoints

1. **`/uuid`** - Fast endpoint (~0ms delay, returns JSON UUID)
2. **`/delay/100`** - 100ms artificial delay endpoint
3. **`/delay/1000`** - 1000ms artificial delay endpoint

## Next Steps

- **proxyFetchNoStorage**: The handler would still be called with an Error if the actual fetch times out. It just might never be called if the communication between the DO and Worker had problems. This would shift the break even point back to delay/200ms. *Probably not worth it.*
- **fetchWithCtn or this.lmz.fetch**: This would be the exact same core code as this.lmz.call except replace the Workers RPC call with the external fetch. It would give us the DX advantages of proxyFetch (continuations, non-async which means it can be called from non-async handlers, parallel fetch execution without messing with Promises) with no added latency. *Easy and probably worth it.*
- **proxyFetchSse**: Similar architecture as current proxyFetch, except instead of returning a ResponseSync, it converts the SSE stream into a series of this.lmz.calls back to the origin DO. The tricky part is sensing when the SSE stream is broken (Worker times out, network glitch, etc.) and resuming it. My first thought is to have the Worker send a heartbeat every 25 seconds starting 25 seconds after the last SSE chunk. If we get to 30 seconds without the heartbeat, we reconnect the SSE stream using the lastEventId. *Probalby only worth it if we need it for MCP.*
