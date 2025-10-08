# @lumenize/testing

A *de*light*ful* testing library for Cloudflare Durable Objects with minimal boilerplate.

For complete documentation, visit **[https://lumenize.com/docs/testing](https://lumenize.com/docs/testing)**

## Features

- **Superset of `cloudflare:test`**: Everything that cloudflare:test provides (runInDurableObject, SELF) and more
- **Change State Inside the DO Before Test Run**: Setup the state for the test
- **Exercise Your DO**: Call your DO as you would in production via fetch or WebSockets
- **Inspect State After**: Assert on anything in the state of the DO (ctx..., env..., instance members, etc.)

## Installation

```bash
npm install --save-dev @lumenize/testing
```

