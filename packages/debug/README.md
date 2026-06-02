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

- **Node.js/Bun/Deno**: `DEBUG=MyApp node app.js`
- **Browser**: `localStorage.setItem('DEBUG', 'MyApp')`
- **Cloudflare Workers**: Set in `wrangler.jsonc` vars or `.dev.vars`

The correct source is selected automatically by package-export *conditions* — no
runtime `try/catch` and no `cloudflare:workers` import in the browser/Node
builds, so this package bundles cleanly for the browser (e.g. inside
`@lumenize/mesh/client`):

| Runtime | Export condition | Reads `DEBUG` from |
| --- | --- | --- |
| Cloudflare Workers | `workerd` / `worker` | `env.DEBUG` (`cloudflare:workers`) |
| Node.js / Bun / Deno | `node` | `process.env.DEBUG` |
| Browser (bundled) | `browser` | `localStorage.getItem('DEBUG')` |

> There is intentionally no `default` condition: a toolchain that presents none
> of the above gets an explicit resolution error rather than a silently-wrong
> build.

### Cloudflare Workers

In Workers, `env.DEBUG` is read via the `workerd` export condition — no manual configuration needed:

```typescript
import { debug } from '@lumenize/debug';

export default {
  async fetch(request: Request, env: Env) {
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
