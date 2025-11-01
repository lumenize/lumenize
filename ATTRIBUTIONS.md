# Code Attributions

This file acknowledges code that has been copied, adapted, or used as inspiration from other open-source projects.

## @ungap/structured-clone (Inspiration)
- **Source**: https://github.com/ungap/structured-clone
- **License**: ISC (https://github.com/ungap/structured-clone/blob/main/LICENSE)
- **Used In**: `packages/structured-clone/` (inspired approach, not copied code)
- **Purpose**: Provided inspiration for structured clone algorithm approach and cycle/alias detection using WeakMap.
- **Date Added**: 2025-01-30
- **Author**: Andrea Giammarchi (@WebReflection)
- **Note**: We implemented our own algorithm from scratch with a different serialization format (tuple-based with `$lmz` references), but were inspired by @ungap/structured-clone's approach to handling cycles and type detection.

## Cap'n Web (Inspiration)
- **Source**: https://github.com/cloudflare/capnweb
- **License**: Apache-2.0 (https://github.com/cloudflare/capnweb/blob/main/LICENSE)
- **Used In**: `packages/structured-clone/` (inspired tuple format)
- **Purpose**: Inspired our tuple-based serialization format `["type", data]` for human-readable, self-describing JSON serialization.
- **Date Added**: 2025-01-30
- **Author**: Cloudflare
- **Note**: Cap'n Web uses a synchronous tuple format without cycles/aliases. We adopted the tuple approach but extended it with `["$lmz", index]` references to support cycles and aliases, and made it async to support Request/Response body reading.

