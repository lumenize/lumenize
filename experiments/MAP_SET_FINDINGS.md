# Map/Set with Object Keys Experiment Results

## Experiment Date
2025-11-07

## Purpose
Test how Map with object keys and Set with object values behave through:
1. DO KV Storage serialization/deserialization
2. Workers RPC serialization/deserialization

## Test Setup
Created DOs that:
- Store Maps/Sets with object keys/values in KV storage
- Send Maps/Sets with object keys/values through RPC
- Test access using: original object, new structurally-equal object, and reconstructed object

## Results

### DO KV Storage

**Map with Object Keys:**
- ❌ `withOriginal`: `undefined` - Original key reference doesn't work
- ❌ `withNew`: `undefined` - New structurally-equal key doesn't work  
- ✅ `withReconstructed`: `user data` - Reconstructed key from Map.keys() works
- ✅ Key structure preserved: `{ userId: 123, role: 'admin' }`

**Set with Object Values:**
- ❌ `hasOriginal`: `false` - Original value reference doesn't work
- ❌ `hasNew`: `false` - New structurally-equal value doesn't work
- ✅ `hasReconstructed`: `true` - Reconstructed value from Set works
- ✅ Value structure preserved: `{ id: 1, name: 'Alice' }`

**Conclusion**: DO KV Storage loses object identity during serialization because each `put()` and `get()` is a separate serialization context.

### Workers RPC

**Map with Object Keys:**
- ✅ `withProvided`: `rpc user data` - **Key sent in same RPC call works!**
- ❌ `withNew`: `undefined` - New structurally-equal key doesn't work
- ✅ `withReconstructed`: `rpc user data` - Reconstructed key works
- ✅ Key structure preserved: `{ userId: 456, role: 'user' }`

**Set with Object Values:**
- ✅ `hasProvided`: `true` - **Value sent in same RPC call works!**
- ❌ `hasNew`: `false` - New structurally-equal value doesn't work
- ✅ `hasReconstructed`: `true` - Reconstructed value works  
- ✅ Value structure preserved: `{ id: 2, name: 'Bob' }`

**Conclusion**: Workers RPC PRESERVES object identity when objects are sent together in the same RPC call. However, creating a new structurally-equal object still doesn't work.

## Key Findings

1. **Identity preserved within serialization boundaries** - Both native `structuredClone()` and `@lumenize/structured-clone` preserve object identity when objects are serialized together in a single call
2. **Identity lost across boundaries** - Separate serialization calls create new objects, losing identity
3. **Structure is always preserved** - All properties of object keys/values are maintained
4. **Workers RPC = one call boundary** - A single RPC method call is one serialization context
5. **DO Storage = separate boundaries** - Each `put()` and `get()` is a separate context

### What This Means

**✅ These preserve identity (same serialization context):**
- `structuredClone({ map, key })` - Native API
- `stringify({ map, key })` - Our package
- `preprocess({ map, key })` - Our package
- `stub.method(map, key)` - Workers RPC

**❌ These lose identity (separate contexts):**
- Serialize map, then separately serialize key
- Store map in DO storage, try to use original key later
- Multiple `preprocess()` calls

## Implications

### For Documentation
- Added ⚠️ warnings to Map and Set in type support table
- Created comprehensive `/docs/structured-clone/maps-and-sets` guide
- Added note linking to the guide from the type support table

### For Users
- **Prefer primitive keys** (strings, numbers) when possible
- **Store key references separately** if you need to look them up later
- **Search through keys** using property matching if needed
- **Understand JavaScript semantics** - this matches native Map/Set behavior with object equality

## Test Files

### DO Storage and Workers RPC Tests
- `/experiments/map-set-object-keys.test.ts` - Tests DO storage and RPC behavior
- `/experiments/wrangler-map-set-test.jsonc` - Wrangler config
- `/experiments/vitest-map-set-test.config.js` - Vitest config

### Native structuredClone Tests
- `/experiments/native-structured-clone-test.js` - Tests native behavior
- `/experiments/lumenize-structured-clone-test.mjs` - Tests our package (Node.js version)

### Identity Preservation Tests (Added to Package)
- `/packages/structured-clone/test/identity-preservation.test.ts` - Proves our package preserves identity within single calls (8 tests, all passing ✅)

## Commands to Reproduce

**DO Storage and RPC experiments:**
```bash
cd /Users/larry/Projects/mcp/lumenize/experiments
vitest run map-set-object-keys.test.ts --config vitest-map-set-test.config.js
```

**Native structuredClone:**
```bash
cd /Users/larry/Projects/mcp/lumenize/experiments
node native-structured-clone-test.js
```

**Identity preservation tests:**
```bash
cd /Users/larry/Projects/mcp/lumenize/packages/structured-clone
npm test identity-preservation.test.ts
```

