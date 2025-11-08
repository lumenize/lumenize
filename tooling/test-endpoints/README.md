# @lumenize/test-endpoints

A de✨light✨ful HTTP test endpoints service for Lumenize integration tests.

**Internal testing package** - Provides httpbin.org-like endpoints with **built-in instrumentation** for testing HTTP operations across Lumenize packages.

## Architecture

Built as a **Cloudflare Durable Object** (DO) for test instrumentation capabilities:
- Worker routes requests to DO instances (one per test suite for isolation)
- DO tracks requests/responses for test inspection via `@lumenize/testing` RPC
- URL format: `/{bindingName}/{instanceName}/{endpoint}`

## Endpoints

All requests require `X-Test-Token: <token>` header or `?token=` query parameter (configured via `TEST_TOKEN` secret/env var).

- **GET /uuid** - Returns JSON with a random UUID
- **GET /json** - Returns sample JSON data (slideshow example)
- **GET /status/{code}** - Returns specified HTTP status code (100-599)
- **GET /delay/{ms}** - Delays response by N milliseconds (max 30000)
- **POST /echo** - Echoes back request body and headers (JSON only)

## Setup

### Local Development

The repository has a root `.dev.vars` file with `TEST_TOKEN` and `TEST_ENDPOINTS_URL`. Test directories symlink to it.

For contributors: Copy `/lumenize/.dev.vars.example` to `/lumenize/.dev.vars` and update if deploying your own instance.

### Production Deployment

Set the `TEST_TOKEN` secret (one-time setup):

```bash
cd packages/test-endpoints
echo "your-secret-token" | wrangler secret put TEST_TOKEN
npm run deploy
```

**Security Note**: The production token must match `TEST_TOKEN` in your root `.dev.vars` file for tests to pass.

## Usage in Tests

### Basic Usage (No Instrumentation)

```typescript
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { env } from 'cloudflare:test';

// Create client with unique instance name for test isolation
const INSTANCE_NAME = 'my-test-suite';
const TEST_ENDPOINTS = createTestEndpoints(
  env.TEST_TOKEN, 
  env.TEST_ENDPOINTS_URL,
  INSTANCE_NAME  // Unique per test suite
);

// Use in tests
const response = await TEST_ENDPOINTS.fetch('/uuid');
const data = await response.json();
// { uuid: '...' }

// Or use createRequest for more control
const request = TEST_ENDPOINTS.createRequest('/json', {
  method: 'GET',
  headers: { 'Custom-Header': 'value' }
});
```

### Advanced Usage (With Instrumentation)

Use `@lumenize/testing` RPC to inspect DO internals:

```typescript
import { createTestEndpoints, buildTestEndpointUrl } from '@lumenize/test-endpoints';
import { createTestingClient } from '@lumenize/testing';
import { env } from 'cloudflare:test';

const INSTANCE_NAME = 'instrumentation-test';

// Create RPC client for DO inspection
using client = createTestingClient(
  'TEST_ENDPOINTS_DO',
  INSTANCE_NAME
);

// Start tracking
await client.startTracking();

// Make request
const url = buildTestEndpointUrl(
  env.TEST_ENDPOINTS_URL,
  '/uuid',
  INSTANCE_NAME,
  env.TEST_TOKEN
);
await fetch(url);

// Inspect instrumentation data via KV storage
const count = await client.ctx.storage.kv.get('stats:count');
expect(count).toBe(1);

// RPC auto-deserializes serialized Request objects
const lastRequest = await client.ctx.storage.kv.get<Request>('request:last');
expect(lastRequest!.url).toContain('/uuid');

// Control tracking
await client.stopTracking();   // Pause tracking
await client.resetTracking();  // Clear all data
```

**Instrumentation KV Keys:**
- `tracking:enabled` - Boolean flag (true by default)
- `stats:count` - Total request count since last reset
- `stats:firstTimestamp` - Date of first request
- `stats:lastTimestamp` - Date of most recent request
- `request:last` - Serialized Request object (auto-deserialized by RPC)
- `response:last` - Serialized Response object (auto-deserialized by RPC)

## Adding to New Test Packages

1. Add symlink to `scripts/setup-symlinks.sh` and run it:
   ```bash
   # Add to SYMLINKS array in setup-symlinks.sh:
   # ".dev.vars:packages/your-package/test/.dev.vars:../../.."
   ./scripts/setup-symlinks.sh
   ```

2. Update your test worker's Env interface:
   ```typescript
   interface Env {
     TEST_TOKEN: string;
     TEST_ENDPOINTS_URL: string;
     TEST_ENDPOINTS_DO: DurableObjectNamespace;  // If using instrumentation
     // ... other bindings
   }
   ```

3. Add binding to your test `wrangler.jsonc` (if using instrumentation):
   ```jsonc
   {
     "durable_objects": {
       "bindings": [
         {
           "name": "TEST_ENDPOINTS_DO",
           "class_name": "TestEndpointsDO",
           "script_name": "test-endpoints"
         }
       ]
     }
   }
   ```

4. Use in tests as shown above.

```typescript
import { buildTestEndpointUrl } from '@lumenize/test-endpoints';

const INSTANCE_NAME = 'my-test';
const url = buildTestEndpointUrl(
  env.TEST_ENDPOINTS_URL,
  '/uuid',
  INSTANCE_NAME,
  env.TEST_TOKEN
);
// Returns: https://.../test-endpoints-do/my-test/uuid?token=...
```

## Instance Isolation

Each test suite should use a **unique instance name** to prevent cross-test interference:

```typescript
// Good - unique per test suite
const INSTANCE_NAME = 'proxy-fetch-integration-test';
const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, INSTANCE_NAME);

// Bad - shared instance causes test interference
const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'default');
```

**Why?** Each DO instance has its own isolated storage. Using unique instance names ensures tests don't see each other's data.

