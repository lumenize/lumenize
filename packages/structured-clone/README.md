# @lumenize/structured-clone

A de✨light✨ful fork of [@ungap/structured-clone](https://github.com/ungap/structured-clone) with extensions for Cloudflare Workers, providing full-fidelity serialization of complex JavaScript types.

For complete documentation, visit **[https://lumenize.com/docs/structured-clone](https://lumenize.com/docs/structured-clone)**

## Features

- **Native Serialization**: Automatic via `stringify`/`parse` - preserves Error objects, Web API objects (Request, Response, Headers, URL), special numbers (NaN, ±Infinity), and all standard structured-clone types
- **Marker-Based Serialization**: Explicit control via `serializeError`/`deserializeError` and `serializeWebApiObject`/`deserializeWebApiObject` for protocol-level errors and queue storage
- **Full Type Support**: Errors with custom properties, Web API objects with body preservation, circular references, and complex nesting

## Installation

```bash
npm install @lumenize/structured-clone
```

## License

ISC (inherited from @ungap/structured-clone)
