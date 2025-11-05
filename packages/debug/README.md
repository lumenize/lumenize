# @lumenize/debug

A de✨light✨ful scoped debug logging system for Cloudflare Durable Objects and browsers.

For complete documentation, visit **[https://lumenize.com/docs/debug](https://lumenize.com/docs/debug)**

## Features

- **Namespace-based filtering**: Control which logs you see with patterns like `DEBUG=proxy-fetch.*`
- **Level support**: debug, info, and warn levels with independent filtering
- **Zero-cost when disabled**: Early returns prevent any computation when logging is off
- **Cloudflare-optimized**: JSON output for queryable Cloudflare log dashboard
- **Dual environments**: NADIC service for DOs, standalone for browsers
- **npm debug compatibility**: Familiar filter syntax with exclusions and wildcards

## Installation

```bash
npm install @lumenize/debug
```

## Quick Start

### Server-Side (Durable Objects)

```typescript
import '@lumenize/debug';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  myMethod() {
    const log = this.svc.createDebug('my-app.feature');
    log.debug('detailed info', { data });
    log.info('milestone reached');
    log.warn('potential issue', { retryCount });
  }
}
```

Set `DEBUG=my-app.*` in your `.dev.vars` or wrangler.jsonc.

### Client-Side (Browser)

```typescript
import { createDebug } from '@lumenize/debug/client';

const log = createDebug('my-app.websocket');
log.debug('connection opened', { id });
log.info('authenticated');
```

Set `localStorage.DEBUG = 'my-app.*'` in browser console.

## Filter Syntax

- `DEBUG=proxy-fetch` - Enable proxy-fetch and all children
- `DEBUG=proxy-fetch:warn` - Only warn level
- `DEBUG=*` - Everything
- `DEBUG=proxy-fetch,-proxy-fetch.verbose` - Exclusions

## License

MIT

