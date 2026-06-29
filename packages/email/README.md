# @lumenize/email

Provider-agnostic email transports (Cloudflare Email Sending, Resend) for Cloudflare Workers, Node.js, and Bun. Near-zero dependencies (only `@lumenize/debug`).

## Installation

```bash
npm install @lumenize/email
```

## Usage

```typescript
import { createEmailTransport } from '@lumenize/email';

// Auto-detects: Cloudflare if the `EMAIL` binding is present, else Resend.
const transport = createEmailTransport(env);

await transport.sendEmail({
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<p>Hello!</p>',
  from: 'hi@myapp.com',
  replyTo: 'noreply@myapp.com',
  appName: 'My App',
  headers: {},
});
```

Select a provider explicitly with `createEmailTransport(env, { provider: 'resend' })`, or set the `EMAIL_PROVIDER` env var. When neither an `EMAIL` binding nor `EMAIL_PROVIDER` is present, it falls back to Resend and logs a `warn` — set `EMAIL_PROVIDER=resend` to make that choice explicit.

## Documentation

Full documentation: https://lumenize.com/docs/email
