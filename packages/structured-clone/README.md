# @lumenize/structured-clone

A fork of **[@ungap/structured-clone](https://github.com/ungap/structured-clone)** with de✨light✨ful extensions to support more types like Request/Response, NaN/Infinity/-Infinity, Error, etc.

For complete documentation, visit **[https://lumenize.com/docs/structured-clone](https://lumenize.com/docs/structured-clone)**

## Features

- **All standard structured-clone types**: Date, RegExp, Map, Set, TypedArrays, ArrayBuffer, circular references using @ungap/structured-clone as-is
- **Extended Error support**: Preserves name, message, stack, and cause (including nested causes)
- **Extended web API serialization**: Request, Response, Headers, URL objects
- **Extended special number handling**: NaN, Infinity, -Infinity

## Other differences from @ungap/structured-clone

- **Async API**: Properly handles Request/Response bodies
- **Clear naming**: `stringify`/`parse` and `preprocess`/`postprocess` (no confusion!)

## Installation

```bash
npm install @lumenize/structured-clone
```

## Quick Start

```typescript
import { stringify, parse } from '@lumenize/structured-clone';

// Serialize complex objects including Errors, Web API objects, etc.
const json = await stringify({
  date: new Date(),
  error: new Error('Something went wrong'),
  special: NaN,
  circular: (() => { const obj = { ref: null }; obj.ref = obj; return obj; })()
});

// Deserialize back to live objects
const restored = await parse(json);
```

## Attribution

This is a fork of [@ungap/structured-clone](https://github.com/ungap/structured-clone) by Andrea Giammarchi (@WebReflection).

**Original License**: ISC
**Our License**: ISC (preserved from original)

We deeply appreciate the excellent work on the original structured-clone implementation.

## License

ISC License - See [LICENSE](./LICENSE) file for details.

Original work Copyright (c) 2021, Andrea Giammarchi, @WebReflection
Modifications Copyright (c) 2025, Larry Maccherone

