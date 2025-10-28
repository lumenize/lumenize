# @lumenize/test-endpoints

A de✨light✨ful HTTP test endpoints service for Lumenize integration tests.

**Internal testing package** - Provides httpbin.org-like endpoints for testing HTTP operations across Lumenize packages.

## Endpoints

All requests require `X-Test-Token: <token>` header (configured via `TEST_TOKEN` secret/env var).

- **GET /uuid** - Returns JSON with a random UUID
- **GET /json** - Returns sample JSON data
- **GET /status/{code}** - Returns specified HTTP status code
- **GET /delay/{seconds}** - Delays response by N seconds (max 30)
- **POST /post** - Echoes back request body and headers

## Setup

### Local Development

Create `.dev.vars` in the test package directory (already gitignored):

```bash
TEST_TOKEN=lumenize-test-local-dev-2025
```

This file is automatically loaded by wrangler during local development and testing.

### Production Deployment

Set the `TEST_TOKEN` secret (one-time setup):

```bash
cd packages/test-endpoints
echo "your-secret-token" | wrangler secret put TEST_TOKEN
npm run deploy
```

**Security Note**: The production token should match the token in your test `.dev.vars` files, or you can use different tokens for local vs production if needed.

## Usage in Tests

The test package must have a `.dev.vars` file with matching `TEST_TOKEN`:

```typescript
import { createTestEndpoints } from '@lumenize/test-endpoints/src/client';
import { env } from 'cloudflare:test';

// In your test
const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN);

const response = await TEST_ENDPOINTS.fetch('/uuid');
const data = await response.json();
// { uuid: '...' }

// Or use createRequest for more control
const request = TEST_ENDPOINTS.createRequest('/json', {
  method: 'GET',
  headers: { 'Custom-Header': 'value' }
});
```

## Adding to New Test Packages

1. Add `.dev.vars` to your test directory (where `wrangler.jsonc` is located):
   ```
   TEST_TOKEN=lumenize-test-local-dev-2025
   ```

2. Add env binding to your test wrangler.jsonc (wrangler loads TEST_TOKEN from .dev.vars):
   ```jsonc
   {
     "vars": {
       "TEST_ENDPOINTS_URL": "https://test-endpoints.transformation.workers.dev"
     }
   }
   ```

3. Update your test worker's Env interface:
   ```typescript
   interface Env {
     TEST_TOKEN: string;
     TEST_ENDPOINTS_URL: string;
     // ... other bindings
   }
   ```

4. Use in tests as shown above.

