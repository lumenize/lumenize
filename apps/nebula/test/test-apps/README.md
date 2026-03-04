# Nebula Test-Apps

Each subdirectory is a mini-app that composes Nebula DOs into a realistic scenario for e2e testing. Tests can mix styles freely — some hit `SELF.fetch` directly, others go through a `NebulaClient` subclass.

## Adding a new test-app

1. Create `test/test-apps/{name}/index.ts` — worker entrypoint, DO re-exports, and test subclasses (import from `'@lumenize/nebula'`)
2. Create `test/test-apps/{name}/test/test-harness.ts` — `instrumentDOProject(sourceModule)` with named DO exports
3. Create `test/test-apps/{name}/test/wrangler.jsonc` — DO bindings, services, vars (`"main": "./test-harness.ts"`)
4. Add a vitest project entry in `apps/nebula/vitest.config.js`
5. Run `npm install` from monorepo root (creates `.dev.vars` symlink automatically)
6. Write test files in `test/test-apps/{name}/`

Use `baseline/` as the template.

## Shared helpers

`test/test-helpers.ts` contains auth helpers (`bootstrapAdmin`, `browserLogin`, `createAuthenticatedClient`, etc.) shared by all test-apps. Import via `'../../test-helpers'`.

`createAuthenticatedClient` is generic — each test-app passes its own client class:

```typescript
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const { client } = await createAuthenticatedClient(
  NebulaClientTest, browser, authScope, activeScope, email,
);
```
