# @lumenize/proxy-fetch

A de✨light✨ful proxy fetch that offloads external API calls from Durable Objects to Workers, eliminating wall-clock billing while waiting for responses.

For complete documentation, visit **[https://lumenize.com/docs/proxy-fetch](https://lumenize.com/docs/proxy-fetch)**

## Features

- **Cost Optimization**: Offload external fetch() calls to Workers to avoid Durable Object wall-clock billing
- **DO-Worker Hybrid**: Uses alarm-based coordination for reliability and low latency
- **Continuation-Based**: Results delivered via OCAN continuations stored in origin DO
- **Linear Scalability**: Tested up to 2000+ concurrent requests
- **Type-Safe**: Full TypeScript support with proper Request/Response handling

## Installation

```bash
npm install @lumenize/proxy-fetch
```
