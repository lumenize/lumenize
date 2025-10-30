# @lumenize/structured-clone

A de✨light✨ful zero-dependency serialization library for Cloudflare Workers with full type support for Errors, Web API objects, and special numbers.

For complete documentation, visit **[https://lumenize.com/docs/structured-clone](https://lumenize.com/docs/structured-clone)**

## Features

- **Zero Dependencies**: Full fork with no runtime dependencies
- **Complete Type Support**: Date, RegExp, Map, Set, Error (with stack traces and cause chains), TypedArrays, circular references
- **Special Numbers**: Preserves NaN, Infinity, -Infinity (unlike JSON)
- **Web API Objects**: Serializes Request, Response, Headers, URL for Cloudflare Workers
- **Async API**: Properly handles Request/Response body reading
- **Single Object Walk**: All type handling in one efficient traversal

## Installation

```bash
npm install @lumenize/structured-clone
```

## Quick Example

```typescript
import { stringify, parse } from '@lumenize/structured-clone';

const data = {
  date: new Date(),
  map: new Map([['key', 'value']]),
  error: new Error('Something went wrong'),
  request: new Request('https://example.com'),
  stats: { average: NaN, max: Infinity }
};

const serialized = await stringify(data);
const restored = await parse(serialized);

// All types preserved!
console.log(restored.date instanceof Date);         // true
console.log(restored.error instanceof Error);       // true
console.log(restored.request instanceof Request);   // true
console.log(Number.isNaN(restored.stats.average)); // true
```

## Attribution

Forked from [@ungap/structured-clone](https://github.com/ungap/structured-clone) by Andrea Giammarchi (@WebReflection).

We deeply appreciate the excellent work on the original structured-clone implementation.

## License

ISC License - See [LICENSE](./LICENSE) file for details.

Original work Copyright (c) 2021, Andrea Giammarchi, @WebReflection  
Modifications Copyright (c) 2025, Larry Maccherone
