# Routing Performance Investigation Notes

## Goal
Understand why `routeDORequest` adds ~0.26ms overhead compared to simple manual routing.

## Initial Hypothesis
The overhead might be from `routeDORequest` trying multiple binding name variations.

## Discovery: Protocol Incompatibility
When attempting to test Lumenize RPC with manual routing (bypassing `routeDORequest`), we discovered that:

**Lumenize RPC and Cap'n Web use incompatible WebSocket protocols.**

- Cap'n Web client (`newWebSocketRpcSession`) cannot connect to Lumenize RPC DO
- Lumenize client (`createRpcClient`) uses `routeDORequest` internally

This means **we cannot isolate routing overhead from protocol overhead**.

## What `routeDORequest` Actually Does

1. **Routing**: Parses URL pattern `/__rpc/{BINDING}/{ID}/call`
2. **Binding resolution**: Tries multiple name variations (BINDING, binding, Binding)
3. **Stub creation**: Gets DO stub by name
4. **Request forwarding**: Calls `stub.fetch(request)`

## What We Know

From Measurement 6 test results:
- **Lumenize with `routeDORequest`**: 0.400ms per mixed operation
- **Cap'n Web with manual routing**: 0.140ms per mixed operation  
- **Gap**: 0.260ms

This gap includes:
- Routing overhead (URL parsing, binding resolution)
- Protocol differences (WebSocket handshake, message format)
- Serialization differences (@ungap/structured-clone vs cbor-x)

## Tasks to Investigate

### High Priority
1. **Profile `routeDORequest` internals**
   - Measure time spent in URL parsing
   - Measure time spent in binding name resolution (try BINDING, binding, Binding)
   - Measure time spent in stub lookup
   - Identify which part dominates the 0.26ms overhead

2. **Create minimal routing helper**
   - Implement simple routing that only accepts exact binding name (no variations)
   - Test if binding name resolution is the bottleneck
   - Compare: `routeDORequest` vs minimal helper vs manual routing

### Medium Priority
3. **Protocol comparison**
   - Document WebSocket protocol differences between Lumenize RPC and Cap'n Web
   - Measure serialization overhead separately (already done in Measurement 3: ~0.07ms)
   - Understand what else contributes to the gap

### Low Priority
4. **Optimization opportunities**
   - If binding resolution is the issue, consider caching or simpler fallback strategy
   - If URL parsing is the issue, consider simpler patterns
   - Document trade-offs: DX (flexibility) vs performance (speed)

## Next Steps

1. Add instrumentation to `routeDORequest` to measure each step
2. Create comparison test with minimal routing helper
3. Document findings in MEASUREMENTS.md
4. Update performance recommendations based on findings
