# @lumenize/state

Path-based reactive store for Lumenize. Works in Cloudflare Workers, Node.js, Bun, and browsers.

## Installation

```bash
npm install @lumenize/state
```

## Usage

```typescript
import { createState } from '@lumenize/state';

const state = createState({ count: 0 });

state.subscribe('count', (value) => {
  console.log('count is now', value);
});

state.setState('count', 1);
// → "count is now 1"
```

## Documentation

Full documentation: https://lumenize.com/docs/state
