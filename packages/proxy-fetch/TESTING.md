# Testing Guide for @lumenize/proxy-fetch

This package includes three types of tests: DO integration/unit tests, Queue variant tests, local-live tests, and production tests.

## DO Integration & Unit Tests

These tests verify all functionality of the DO variant of proxy-fetch using Cloudflare's vitest pool for Workers.

**Run DO variant tests:**
```bash
npm run test:do
```

**What's tested:**
- Queue operations (enqueue, ULID ordering, FIFO)
- Fetch processing (success, errors, retries, fire-and-forget, parallel requests)
- Integration scenarios (full flow, error handling, retries, parallel requests)
- All 13 tests in `test/do/`

## Queue Variant Tests

These tests verify the Queue variant of proxy-fetch that uses Cloudflare Queues instead of Durable Object storage.

**Run Queue variant tests:**
```bash
npm run test:queue
```

**What's tested:**
- proxyFetch() function (queuing requests with URLs and Request objects)
- Queue consumer processing (message batches, error handling)
- Request serialization/deserialization
- Error handling and retries (timeouts, network errors, 5xx/4xx responses)
- All 11 tests in `test/queue/`

**Known issues:**
- 1 test currently fails due to test-endpoints not echoing all custom headers in `/post` responses. This is a test infrastructure limitation, not a proxy-fetch bug.

## Run All Tests

Run both DO and Queue variant tests:
```bash
npm test
```

**Coverage:**
```bash
npm run test:coverage
```

## Local Live Tests

These tests run against a local `wrangler dev` server to validate the production test Worker in a local environment before deploying.

**Prerequisites:**
1. Copy `test/production/.dev.vars.example` to `test/production/.dev.vars`
2. Add your `TEST_TOKEN` to `.dev.vars`

**Run local live tests:**

Terminal 1 - Start the development server:
```bash
npm run dev:production
```

Terminal 2 - Run the tests:
```bash
npm run test:local-live
```

**What's tested:**
- Health check endpoint
- UUID fetch with callback (basic flow)
- UUID fetch with retry logic (5xx errors)
- Fire-and-forget requests (no callback)

## Production Tests

These tests run against the deployed production Worker to validate everything works in the real Cloudflare Workers environment.

**Prerequisites:**
1. Deploy the production test Worker:
   ```bash
   npm run deploy:production
   ```
   This deploys to `proxy-fetch-live-test.transformation.workers.dev`

2. Set the `TEST_TOKEN` secret:
   ```bash
   wrangler secret put TEST_TOKEN --config test/production/wrangler.jsonc
   ```
   (Use the same token value from test-endpoints deployment)

**Run production tests:**
```bash
npm run test:production
```

**What's tested:**
- Same 4 tests as local-live, but against the deployed Worker
- Validates production deployment configuration
- Confirms SQLite backend, migrations, and DO bindings work correctly

## Test Structure

```
test/
├── do/                          # DO integration & unit tests
│   ├── queue.test.ts           # Queue operations
│   ├── fetch-processing.test.ts # Fetch processing & retries
│   ├── integration.test.ts     # End-to-end integration
│   ├── test-worker.ts          # Test DOs and instrumented wrapper
│   ├── wrangler.jsonc          # DO test configuration
│   └── worker-configuration.d.ts # Auto-generated types
│
├── production/                  # Production test Worker & tests
│   ├── worker.ts               # Production test Worker
│   ├── wrangler.jsonc          # Production Worker config
│   ├── local-live.test.mjs     # Local live tests (Node.js)
│   ├── production.test.mjs     # Production tests (Node.js)
│   └── .dev.vars.example       # Example environment variables
│
└── queue/                       # Queue variant tests (legacy)
    └── ...
```

## Updating Type Definitions

After modifying `test/do/wrangler.jsonc`, regenerate the TypeScript types:

```bash
npm run types
```

This runs `wrangler types` in the `test/do` directory and updates `worker-configuration.d.ts`.

## Continuous Integration

For CI environments, run only the DO integration/unit tests:

```bash
npm test
```

Production and local-live tests require manual setup (secrets, deployment) and are intended for manual validation.
