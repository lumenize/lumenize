# @lumenize/core

A de✨light✨ful collection of core injectables for Cloudflare Durable Objects. Universal utilities that work standalone or auto-inject via LumenizeBase.

For complete documentation, visit **[https://lumenize.com/docs/core](https://lumenize.com/docs/core)**

## Features

- **`sql` Template Literal Tag**: Clean, safe SQL queries with automatic parameter binding
- **Standalone or Injectable**: Use directly or auto-wire with LumenizeBase
- **Type-Safe**: Full TypeScript support with automatic type merging
- **Zero Dependencies**: Lightweight wrapper around Cloudflare's native SQL storage

## Installation

```bash
npm install @lumenize/core
```

## Quick Start

### Standalone Usage

```typescript
import { DurableObject } from 'cloudflare:workers';
import { sql } from '@lumenize/core';

export class MyDO extends DurableObject {
  #sql = sql(this);
  
  async getUser(userId: string) {
    const rows = this.#sql`SELECT * FROM users WHERE id = ${userId}`;
    return rows[0];
  }
}
```

### With LumenizeBase (Auto-Injected)

```typescript
import { LumenizeBase } from '@lumenize/lumenize-base';

export class MyDO extends LumenizeBase<Env> {
  async getUser(userId: string) {
    // this.svc.sql is automatically available!
    const rows = this.svc.sql`SELECT * FROM users WHERE id = ${userId}`;
    return rows[0];
  }
}
```

## License

MIT

