# @lumenize/debug

A de✨light✨ful scoped debug logging system for Cloudflare Durable Objects.

For complete documentation, visit **[https://lumenize.com/docs/debug](https://lumenize.com/docs/debug)**

## Features

- **Namespace filtering**: Control logs with patterns like `DEBUG=proxy-fetch.*`
- **Level support**: `debug`, `info`, and `warn` levels with independent filtering
- **Zero-cost when disabled**: Early exit prevents computation when logging is off
- **JSON output**: Structured logs integrate with Cloudflare's log dashboard
- **NADIS integration**: Auto-injected into `LumenizeBase` via `this.svc.debug`

## Installation

```bash
npm install @lumenize/debug
```

## Quick Start

```typescript
import '@lumenize/debug';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  async fetch(request: Request) {
    const log = this.svc.debug('my-app.http');
    log.debug('Processing request', { url: request.url });
    log.info('Request completed', { status: 200 });
    return new Response('OK');
  }
}
```

Configure via `DEBUG` environment variable in `.dev.vars`:

```bash
DEBUG=my-app.*
```

## License

MIT

