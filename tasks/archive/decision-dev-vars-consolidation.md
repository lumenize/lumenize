# .dev.vars Consolidation

**Status**: ✅ Implemented  
**Date**: October 29, 2025

## Problem

Multiple `.dev.vars` files scattered across the monorepo, all containing identical secrets. Hard to maintain, easy for values to drift.

## Solution

Single root `/lumenize/.dev.vars` with symlinks from test directories.

## Implementation

### Structure

```
lumenize/
├── .dev.vars                    # Master file (gitignored)
├── .dev.vars.example            # Template for contributors
└── packages/
    ├── test-endpoints/
    │   └── .dev.vars → ../../.dev.vars (symlink)
    └── proxy-fetch/test/
        ├── do/.dev.vars → ../../../../.dev.vars (symlink)
        ├── queue/.dev.vars → ../../../../.dev.vars (symlink)
        ├── for-docs/.dev.vars → ../../../../.dev.vars (symlink)
        └── production/.dev.vars → ../../../../.dev.vars (symlink)
```

### Root .dev.vars Content

```bash
# Test token for test-endpoints service
TEST_TOKEN=8b169d0d-0ad0-4a62-ad64-79d218508041

# Test endpoints URL (allows contributors to use their own deployment)
TEST_ENDPOINTS_URL=https://test-endpoints.transformation.workers.dev
```

## Code Changes

### 1. test-endpoints Client API
- **Before**: `createTestEndpoints(token: string)`
- **After**: `createTestEndpoints(token: string, baseUrl: string)`

### 2. Removed Hardcoded URLs
- `packages/proxy-fetch/test/do/test-worker.ts`: Now uses `env.TEST_ENDPOINTS_URL`
- `packages/proxy-fetch/test/do/wrangler.jsonc`: Removed `vars.TEST_ENDPOINTS_URL`
- `packages/proxy-fetch/test/production/wrangler.jsonc`: Removed `vars.TEST_ENDPOINTS_URL`

### 3. Updated .dev.vars.example Files
All `.dev.vars.example` files now include both:
- `TEST_TOKEN` with guidance
- `TEST_ENDPOINTS_URL` with default value

## Benefits

✅ **Single source of truth** - Update once, works everywhere  
✅ **Consistent values** - No drift between test environments  
✅ **Contributor friendly** - Clear `.dev.vars.example` with instructions  
✅ **Flexible** - Contributors can point to their own deployments  
✅ **No hardcoded URLs** - Everything configurable via environment

## Testing

All 35 tests pass across all test environments:
- DO tests (8 test files)
- Queue tests
- Integration tests
- RPC-based tests
- Production environment tests

## Contributor Setup

```bash
# Clone repo
git clone https://github.com/user/lumenize.git
cd lumenize

# Install dependencies (automatically sets up symlinks via postinstall)
npm install

# Copy example
cp .dev.vars.example .dev.vars

# Run tests (symlinks just work)
cd packages/proxy-fetch
npm test
```

### Symlink Maintenance Script

**`scripts/setup-symlinks.sh`**
- Automatically runs after `npm install` (via `postinstall` hook)
- Can be run manually anytime: `./scripts/setup-symlinks.sh`
- Idempotent - safe to run repeatedly
- Smart detection:
  - ✓ Skips correct symlinks
  - ✓ Recreates missing symlinks
  - ⚠️ Warns about incorrect symlinks
  - ⚠️ Skips regular files (won't overwrite)
- Creates parent directories if needed
- Reminds about `.dev.vars.example` if root `.dev.vars` missing

## Future Considerations

- Wrangler automatically walks up directories to find `.dev.vars`
- Could potentially remove symlinks and rely on this behavior
- Would need testing to verify across all environments
- Current symlink approach is explicit and predictable

## Related Files

- `/lumenize/.dev.vars`
- `/lumenize/.dev.vars.example`
- `/lumenize/packages/test-endpoints/README.md`
- `/lumenize/packages/test-endpoints/src/client.ts`

