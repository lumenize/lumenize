# @lumenize/for-experiments

Reusable tooling for production experiments on Cloudflare Workers and Durable Objects.

## Purpose

Standardizes experiment setup to avoid repeating the same WebSocket handling, progress reporting, and result formatting across multiple experiments. Provides a consistent protocol between Node.js test clients and Durable Object controllers.

## Architecture

### Server-Side: `ExperimentController`

A base Durable Object class that handles:
- WebSocket connection management
- Batch test execution with progress updates
- Error handling and reporting
- Pattern routing via handler registry

**Extend and override `getVariations()`:**

```typescript
import { ExperimentController, type VariationDefinition } from '@lumenize/for-experiments';

export class MyController extends ExperimentController<Env> {
  // Register variations with metadata
  protected getVariations() {
    return new Map<string, VariationDefinition>([
      ['variation-a', {
        name: 'Variation A',
        description: 'What variation A tests',
        handler: this.#runVariationA.bind(this)
      }],
      ['variation-b', {
        name: 'Variation B',
        description: 'What variation B tests',
        handler: this.#runVariationB.bind(this)
      }],
    ]);
  }

  async #runVariationA(index: number): Promise<void> {
    // Implement variation A logic
  }

  async #runVariationB(index: number): Promise<void> {
    // Implement variation B logic
  }
}
```

The base class automatically routes incoming batch operations to the appropriate handler based on the `mode` parameter.

### Client-Side: Node.js Functions

Import from `@lumenize/for-experiments/node-client`:

**`runBatch(wsUrl, mode, count, timeout?)`**
- Connects to WebSocket
- Sends batch request
- Streams progress updates
- Returns results object

**`displayResults(results)`**
- Formats and displays results
- Shows timing, throughput, errors

## Protocol

### REST Endpoints (Queries)

Implement in your Worker's fetch handler:

```typescript
// GET /patterns - Discover available test modes
if (url.pathname === '/patterns') {
  return new Response(JSON.stringify({ 
    patterns: PATTERNS // Array of { mode, name, description }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### WebSocket (Streaming Execution)

**Client → Server:**
```json
{
  "action": "run-batch",
  "mode": "test-mode-name",
  "count": 50
}
```

**Server → Client (progress):**
```json
{
  "type": "progress",
  "mode": "test-mode-name",
  "completed": 25,
  "total": 50,
  "elapsed": 1.2
}
```

**Server → Client (completion):**
```json
{
  "type": "batch-complete",
  "mode": "test-mode-name",
  "totalTime": 2400,
  "completed": 50,
  "errors": 0,
  "errorMessages": []
}
```

## Example Usage

### 1. Define Your Controller

```typescript
// src/index.ts
import { 
  ExperimentController,
  type VariationDefinition 
} from '@lumenize/for-experiments';

export class MyController extends ExperimentController<Env> {
  protected getVariations() {
    return new Map<string, VariationDefinition>([
      ['test-a', {
        name: 'Test A',
        description: 'Description of test A',
        handler: this.#runTestA.bind(this)
      }],
      ['test-b', {
        name: 'Test B',
        description: 'Description of test B',
        handler: this.#runTestB.bind(this)
      }],
    ]);
  }

  async #runTestA(index: number): Promise<void> {
    // Run test A logic
  }

  async #runTestB(index: number): Promise<void> {
    // Run test B logic
  }
}

// Worker - uses standard experiment fetch handler
export default ExperimentController.createFetchHandler('CONTROLLER');
```

That's it! The `ExperimentController.createFetchHandler()` automatically provides:
- `GET /version` - Version info
- `GET /patterns` - Variation discovery (calls `listVariations()`)
- WebSocket upgrade - Batch execution with streaming

### 2. Create Test Client

**Simple version** (recommended):
```javascript
// test/measurements.mjs
import { runAllExperiments } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const OPS_COUNT = parseInt(process.argv[2] || '50', 10);

runAllExperiments(BASE_URL, OPS_COUNT)
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
```

That's it! `runAllExperiments()` automatically:
- Discovers all patterns
- Runs batch for each pattern
- Displays progress updates
- Shows comparison table with per-op averages

**Advanced version** (for custom logic):
```javascript
// test/measurements.mjs
import { runBatch, displayResults } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');

async function runExperiment() {
  // Discover patterns
  const response = await fetch(`${BASE_URL}/patterns`);
  const { patterns } = await response.json();
  
  // Run each pattern with custom logic
  for (const pattern of patterns) {
    console.log(`Testing: ${pattern.name}`);
    const result = await runBatch(WS_URL, pattern.mode, 50);
    displayResults({ ...pattern, ...result });
  }
}

runExperiment();
```

### 3. Configure Wrangler

```jsonc
{
  "name": "my-experiment",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-12",
  "durable_objects": {
    "bindings": [
      { "name": "CONTROLLER", "class_name": "MyController" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyController"] }
  ]
}
```

## Files

- **`src/controller.ts`** - `ExperimentController` base class (TypeScript)
- **`src/node-client.js`** - Node.js client utilities (JavaScript)
- **`src/index.ts`** - Package exports

## Design Decisions

- **TypeScript for DO code**: Auto-transpiled by wrangler/vitest
- **JavaScript for Node client**: Runs directly, no build step
- **REST for queries, WS for streaming**: Clean protocol separation
- **Auto-discovery**: Clients query server for available tests
