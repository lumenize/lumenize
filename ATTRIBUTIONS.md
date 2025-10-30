# Code Attributions

This file acknowledges code that has been copied, adapted, or used as inspiration from other open-source projects.

## @ungap/structured-clone
- **Source**: https://github.com/ungap/structured-clone
- **License**: ISC (https://github.com/ungap/structured-clone/blob/main/LICENSE)
- **Used In**: `packages/structured-clone/` (complete fork with extensions)
- **Purpose**: Structured clone algorithm polyfill. We forked this project to add Lumenize-specific extensions for serializing Errors, Web API objects (Request, Response, Headers, URL), and special numbers (NaN, ±Infinity) while maintaining zero runtime dependencies.
- **Date Added**: 2025-01-30
- **Author**: Andrea Giammarchi (@WebReflection)
- **Changes**: 
  - Made API async to support Request/Response body reading
  - Renamed serialize/deserialize to preprocess/postprocess
  - Added support for Error objects with full fidelity (name, message, stack, cause)
  - Added support for Web API objects (Request, Response, Headers, URL)
  - Added support for special numbers (NaN, Infinity, -Infinity)
  - Changed marker prefix from none to `__lmz_` for Lumenize extensions

