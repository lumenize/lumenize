---
title: "@lumenize/auth now sends via Cloudflare Email Sending"
slug: auth-on-cloudflare-email
authors:
  - larry
tags:
  - auth
  - cloudflare
description: Cloudflare Email Sending just went to open beta. We've made it the default transport for @lumenize/auth — one binding replaces an API key and a REST call, and it fits the Cloudflare-first posture of the rest of the stack. Resend still works — it's one subclass name away.
draft: false
---

Cloudflare recently opened the beta for [Email Sending](https://developers.cloudflare.com/email-service/). `@lumenize/auth` has switched its default email transport to use it.

<!-- truncate -->

## What changed

Before, the recommended path looked like this:

```typescript
import { ResendEmailSender } from '@lumenize/auth';

export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@myapp.com';
}
```

Plus a `RESEND_API_KEY` secret in `.dev.vars` and `wrangler secret`.

Now the default is:

```typescript
import { CloudflareEmailSender } from '@lumenize/auth';

export class AuthEmailSender extends CloudflareEmailSender {
  from = 'auth@myapp.com';
}
```

Plus one `send_email` entry in `wrangler.jsonc`:

```jsonc
{
  "send_email": [
    { "name": "EMAIL" }
  ]
}
```

No secret. No REST call. Just a Worker binding.

## Why we switched

The template/subject/dispatch machinery in `@lumenize/auth` was already transport-agnostic — `AuthEmailSenderBase` handles everything; the `sendEmail()` method is the only thing a transport needs to implement. So the migration was a 30-line `CloudflareEmailSender` class that calls `env.EMAIL.send(...)` instead of `fetch('https://api.resend.com/emails', ...)`.

Two reasons the binding path is nicer:

**One fewer secret to rotate.** The `send_email` binding authenticates automatically. No API key in `.dev.vars`, no `wrangler secret put`, no forgotten rotation. When you verify your domain in Cloudflare, you get SPF, DKIM, DMARC, and bounce handling wired up for you on `cf-bounce` subdomains — all the deliverability hygiene that used to be your DNS dashboard's problem.

**It fits the Cloudflare-first posture.** `@lumenize/auth` already runs in Workers, stores tokens in Durable Object SQLite, rate-limits via Cloudflare's rate-limit binding, and (optionally) protects the magic-link endpoint with Turnstile. Sending email via a Cloudflare binding is the same pattern: configure a binding, use the binding, ship.

## The tradeoff: Workers Paid plan

Cloudflare Email Sending requires the Workers Paid plan — entry tier is $5/month. Resend's free tier is 100 emails/day. If you're just kicking the tires or running a hobby project and don't want to upgrade, `ResendEmailSender` is still a first-class alternative — just a one-line change in your subclass. See [Using Resend instead](/docs/auth/using-resend-instead).

Everything around the transport is identical between the two — same `from`, `replyTo`, `appName` instance variables, same overridable template and subject methods, same `AUTH_EMAIL_SENDER` service binding wiring. Switching later is a base class rename.

## Non-breaking for existing users

If you're already running `ResendEmailSender` in production, you don't need to do anything. `ResendEmailSender` still ships, still works, still tested. The only change is which sender the docs recommend by default.

## Getting started

For new projects, start here: [@lumenize/auth: Email Provider](/docs/auth/getting-started#email-provider). The 3-step setup (onboard domain → write a subclass → add two bindings) should take about 5 minutes.

For existing projects that want to switch from Resend to Cloudflare: change the base class (`ResendEmailSender` → `CloudflareEmailSender`), add the `send_email` binding to `wrangler.jsonc`, remove the `RESEND_API_KEY` secret. You can do that on a Friday afternoon.
