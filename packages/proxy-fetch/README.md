# @lumenize/proxy-fetch

A de✨light✨ful proxy fetch that offloads external API calls from Durable Objects to Workers via Cloudflare Queues, eliminating wall-clock billing while waiting for responses.

For complete documentation, visit **[https://lumenize.com/docs/proxy-fetch](https://lumenize.com/docs/proxy-fetch)**

## Features

- **Cost Optimization**: Offload external fetch() calls to Workers to avoid Durable Object wall-clock billing
- **Queue-Based**: Uses Cloudflare Queues for reliable message delivery
- **Hibernation-Safe**: Callback pattern works across DO hibernation cycles
- **Type-Safe**: Full TypeScript support with proper Request/Response handling

## Installation

```bash
npm install @lumenize/proxy-fetch
```
