# Code Patterns

Standard coding patterns and conventions for Lumenize packages.

## Type System

### Rule of Wire Separation for Types

**When:** Defining data structures in TypeScript

**Then:** Choose the right tool based on whether data crosses boundaries:

- ✅ **Use TypeScript types** for transient in-memory constructs
- ✅ **Use TypeBox schemas** for any structure that can cross a process, network, or persistence boundary

**Why:** TypeBox provides runtime validation and serialization, TypeScript types are compile-time only.

## Package Structure

### Development Mode

During development, packages point directly to source files:

```json
{
  "main": "src/index.ts",
  "types": "src/index.ts",
  "files": ["src/**/*"]
}
```

**Why:** No build step during development eliminates build cache issues, simplifies debugging, and provides immediate feedback.

### Publish Mode

Build happens only during publish (see `scripts/build-packages.sh`, `scripts/prepare-for-publish.sh`):
- TypeScript compiled to `dist/`
- `package.json` temporarily modified to point to `dist/`
- After publish, `scripts/restore-dev-mode.sh` reverts to `src/`

**See:** Publishing and Releases section in `.cursorrules` (workspace rules) for details.

## Imports

### Intra-monorepo Imports

**From exported public API:**
```typescript
import { something } from '@lumenize/some-package'
```

**From same package (non-exported):**
```typescript
import { something } from './some-file.ts'
```

**Only use relative imports** when:
- Importing from the same npm workspace package
- The item is NOT exported from the package's `index.ts`

## Coding Style

### Private Class Members

**Always:**
```typescript
class MyClass {
  #privateField = 'secret';
  
  #privateMethod() {
    return this.#privateField;
  }
}
```

**Never:**
```typescript
class MyClass {
  private privateField = 'secret';  // ❌ Compile-time only
}
```

**Why:** JavaScript `#` prefix provides true runtime privacy, TypeScript `private` is erased at compile time.

## NPM Package Management

### Before Installing

**Always:**
- ✅ Ask permission before installing any npm packages
- ✅ Check if functionality can be implemented in <100 SLOC
- ✅ Use only well-known, well-maintained packages
- ✅ Verify permissive licenses (MIT, Apache-2.0, BSD-3-Clause, ISC)

### Package Selection Criteria

**Prefer packages with:**
- ✅ Smallest once-built footprint over fastest
- ✅ Strongest Cloudflare Workers compatibility
- ✅ Active maintenance and good documentation

**Never:**
- ❌ Install npm packages globally

### Attribution

When copying liberally-licensed code (typically <1000 SLOC):
1. Add entry to `ATTRIBUTIONS.md` at repository root
2. Add comment above copied code in source file

**See:** Code Attribution section in workspace rules for detailed format.

## Reference

For comprehensive project structure and workflow details, see workspace-level rules in the root `.cursorrules` file.

