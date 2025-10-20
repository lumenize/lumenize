# Manual Performance Testing Instructions

This document guides you through running three configurations to collect routing performance data.

## Setup

Both test files have configuration flags at the top:
- `test/performance.test.ts` - TEST_CONFIG
- `test/test-worker-and-dos.ts` - ROUTING_CONFIG

**CRITICAL**: These flags must match! Enable the same configuration in both files.

## Test Procedure

Run each configuration 3 times and record all results.

### Configuration 1: Lumenize with routeDORequest

**Purpose**: Baseline - Lumenize using the `routeDORequest` helper (current recommended pattern)

**Enable in both files**:
```typescript
LUMENIZE_WITH_ROUTE_DO_REQUEST: true,
LUMENIZE_WITH_MANUAL_ROUTING: false,
CAPNWEB_WITH_MANUAL_ROUTING: false,
```

**Run 3 times**:
```bash
npm test  # Run 1
npm test  # Run 2
npm test  # Run 3
```

**Record**:
- increment: Average ms per operation from all 3 runs
- getValue: Average ms per operation from all 3 runs
- mixed ops: Average ms per operation from all 3 runs

---

### Configuration 2: Lumenize with Manual Routing

**Purpose**: Measure routing overhead - Same Lumenize RPC but with simple manual regex routing instead of `routeDORequest`

**Change configuration in both files**:
```typescript
LUMENIZE_WITH_ROUTE_DO_REQUEST: false,
LUMENIZE_WITH_MANUAL_ROUTING: true,
CAPNWEB_WITH_MANUAL_ROUTING: false,
```

**Run 3 times**:
```bash
npm test  # Run 1
npm test  # Run 2
npm test  # Run 3
```

**Record**:
- increment: Average ms per operation from all 3 runs
- getValue: Average ms per operation from all 3 runs
- mixed ops: Average ms per operation from all 3 runs

---

### Configuration 3: Cap'n Web with Manual Routing

**Purpose**: Comparison - Cap'n Web using their recommended manual routing pattern

**Change configuration in both files**:
```typescript
LUMENIZE_WITH_ROUTE_DO_REQUEST: false,
LUMENIZE_WITH_MANUAL_ROUTING: false,
CAPNWEB_WITH_MANUAL_ROUTING: true,
```

**Run 3 times**:
```bash
npm test  # Run 1
npm test  # Run 2
npm test  # Run 3
```

**Record**:
- increment: Average ms per operation from all 3 runs
- getValue: Average ms per operation from all 3 runs
- mixed ops: Average ms per operation from all 3 runs

---

## Results Template

Copy this to MEASUREMENTS.md after completing all tests:

```markdown
### 2025-01-20 [Routing Overhead Analysis - Three-Way Comparison]

**Git Hash**: (after completing tests)

**Test Results** (average of 3 runs each):

| Configuration | increment | getValue | mixed ops |
|--------------|-----------|----------|-----------|
| **Config 1: Lumenize + routeDORequest** | X.XXXms | X.XXXms | X.XXXms |
| **Config 2: Lumenize + Manual Routing** | X.XXXms | X.XXXms | X.XXXms |
| **Config 3: Cap'n Web + Manual Routing** | X.XXXms | X.XXXms | X.XXXms |

**Routing Overhead Analysis**:
- Config 1 vs Config 2 gap: X.XXXms - This is pure `routeDORequest` overhead
- Config 2 vs Config 3 gap: X.XXXms - This is serialization + protocol differences

**Key Findings**:
[To be filled in after analyzing results]
```

## What Each Configuration Tests

### Config 1 vs Config 2 (Both Lumenize)
- **Same**: Protocol, serialization, client, DO implementation
- **Different**: Worker routing (routeDORequest vs manual regex)
- **Isolates**: Pure routing helper overhead

### Config 2 vs Config 3 (Manual routing for both)
- **Same**: Worker routing style (both use simple regex)
- **Different**: Protocol, serialization, DO wrapper
- **Isolates**: Framework differences (Lumenize vs Cap'n Web)

### Config 1 vs Config 3 (Current comparison)
- **Different**: Everything (routing + protocol + serialization)
- **Shows**: Total end-to-end difference
