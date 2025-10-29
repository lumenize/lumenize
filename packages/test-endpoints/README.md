# @lumenize/test-endpoints

A de✨light✨ful HTTP test endpoints service for Lumenize integration tests.

**Internal testing package** - Provides httpbin.org-like endpoints for testing HTTP operations across Lumenize packages.

## Endpoints

All requests require `X-Test-Token: <token>` header (configured via `TEST_TOKEN` secret/env var).

- **GET /uuid** - Returns JSON with a random UUID
- **GET /json** - Returns sample JSON data
- **GET /status/{code}** - Returns specified HTTP status code
- **GET /delay/{seconds}** - Delays response by N seconds (max 30)
- **POST /echo** - Echoes back request body and headers

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

```typescript
import { createTestEndpoints } from '@lumenize/test-endpoints/src/client';
import { env } from 'cloudflare:test';

// In your test
const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL);

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

1. Create a symlink to root `.dev.vars`:
   ```bash
   ln -sf ../../../../.dev.vars packages/your-package/test/.dev.vars
   ```

2. Update your test worker's Env interface:
   ```typescript
   interface Env {
     TEST_TOKEN: string;
     TEST_ENDPOINTS_URL: string;
     // ... other bindings
   }
   ```

3. Use in tests as shown above.

