# @lumenize/debug

Zero-dependency debug logging for Cloudflare Workers, Node.js, Bun, and browsers.

## Installation

```bash
npm install @lumenize/debug
```

## Usage

```typescript
import { debug } from '@lumenize/debug';

const log = debug('MyApp.myFunction');
log.debug('processing request', { url, method });
log.info('milestone reached', { step: 3 });
log.warn('retry limit reached', { retryCount: 5 });
log.error('unexpected failure', { error: e.message }); // ALWAYS outputs
```

## Configuration

Set the `DEBUG` environment variable (uppercase) to filter which namespaces log:

- **Node.js/Bun**: `DEBUG=MyApp node app.js`
- **Browser**: `localStorage.setItem('DEBUG', 'MyApp')`
- **Cloudflare Workers**: Set in `wrangler.jsonc` vars or `.dev.vars`

### Cloudflare Workers

In Workers, call `debug.configure(env)` once per request:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    debug.configure(env);

    const log = debug('Worker.router');
    log.debug('Routing request');

    return new Response('OK');
  }
};
```

## Filter Patterns

- `DEBUG=MyApp` - Enable MyApp and all children
- `DEBUG=MyApp:warn` - Only warn+ level for MyApp
- `DEBUG=*` - Enable everything
- `DEBUG=MyApp,-MyApp.verbose` - Exclusions

## Documentation

Full documentation: https://lumenize.com/docs/debug
