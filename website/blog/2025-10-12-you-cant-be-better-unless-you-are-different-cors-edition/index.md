---
title: "You can't be better unless you are different — CORS edition"
slug: you-cant-be-better-unless-you-are-different-cors-edition
authors: [larry]
tags: [security, architecture]
description: A pragmatic, consistent server-side approach to CORS for both HTTP and WebSockets—why browsers behave differently, how to implement a unified gate, and what trade-offs to consider.
image: ./no-trespassing.png
---

![No Trespassing](./no-trespassing.png)

# You can't be better unless you are different — CORS edition

*I was today years old when I learned how WebSockets and CORS really work.* And: how CORS can be implemented in a non‑standard (but arguably better) way.

One of the "Larry-isms" that my family and coworkers are tired of hearing is, "You can't be better unless you are different." It's not an endorsement for being different just to be different but rather, to look for opportunities to deviate from the norm when you think you have found a better way to do something. I always follow it with a statement that just because you think you have a better way doesn't mean that you actually do — and that may very well be the case with what I did today.

I implemented a non-standard way of handling Cross-Origin Resource Sharing (CORS) in Lumenize. You be the judge of whether or not it's better.

<!-- truncate -->

---

:::tip TL;DR
Browsers enforce CORS for HTTP, but not for WebSocket upgrades. We implemented a single server‑side origin gate for both. It’s not a security boundary; it reduces accidental cross‑origin use and wasted work. Mind preflight nuances and clients that don’t send `Origin`.
:::

## Quick refresher: how CORS actually works (HTTP)

You probably know this part, but let’s just set the stage. CORS is a mechanism that browsers use to control which domains can access resources on your server. It was kind of bolted onto the web after HTTP was already a thing. So the enforcement is done by the browser, not the server. The server just sends headers like `Access-Control-Allow-Origin`, and the browser decides if it’s going to let the JavaScript code see the response.

Important nuances:

- For simple requests (e.g., GET without custom headers), the browser sends the request and will block the calling JS from reading the response if the CORS headers don’t allow it. Your server work still happened.
- For non‑simple requests, the browser first sends a preflight `OPTIONS` request. If the preflight fails, the actual request is never sent. Your app logic didn’t run, though you still handled the preflight.
- Either way, CORS is enforced by the browser. Non‑browser clients (curl, server‑to‑server, mobile SDKs) can ignore it entirely.

---

## WebSockets throw a wrench in the works

I was today years old when I learned this, but...

Even though WebSockets came along after CORS HTTP behavior was defined, the initial WebSocket handshake never got that same built-in browser CORS enforcement, even though it is technically an HTTP request. The browser sends an `Origin` header with the handshake, but it does not enforce CORS. If you want to block WebSocket connections by origin, you have to do it on the server side.

---

## Why the inconsistency matters

So if you’re running a server that supports both HTTP and WebSockets, you suddenly find yourself in this weird split world. For HTTP, you can rely on the browser. For WebSockets, you can’t.

---

## Disallowed cross‑origin HTTP requests can still do work

As noted above, for simple requests the server often processes the request even when the browser will later block the frontend from reading it. For preflighted requests, the preflight can prevent the actual request from reaching your handler at all—but you still spent cycles answering the preflight.

---

## Our (slightly controversial) implementation

And here’s the punchline. If you’re already doing that origin check for WebSockets on the server, why not just do it for HTTP too? Instead of waiting for the browser to handle CORS, you can enforce the same policy server-side for both. Reject any request that doesn’t come from an allowed origin right away. It’s a consistent approach, it can save you some compute cycles, and it puts you a little more in control.

Note: CORS was never a security mechanism. An attacker can get around it by sending in whatever Origin header they want. CORS is at best a hint and at worst a false sense of security. Think of it like a “No Trespassing” sign — it works only if the intruder cares what it says.

What our implementation does, besides creating consistency between WebSocket upgrade and regular HTTP requests, is add a short fence to go with the "No Trespassing" sign. An attacker can easily step over it, but casual accidental trespassing is a little less likely.

Contract in plain English:

- Inputs: `Request` with optional `Origin`, method, and optional WebSocket `Upgrade` header; allowlist.
- Behavior: deny early on disallowed origins for both HTTP and WS; honor preflight only for allowed origins; set `Vary: Origin` when echoing origin.
- Outcome: consistent policy across protocols, less wasted work, clearer logs.

---

## Caveats and trade‑offs (and how Lumenize handles them)

Although not all of it is in the components we have open-sourced, the commercial version of Lumenize does all of this and you should keep these items in mind if you decide to implement your own non-standard implementation:

- Do not treat CORS as a security boundary—authenticate and authorize requests explicitly.
- Decide on a policy for `Origin: null` or missing; some legit clients won't send it.
- Add `Vary: Origin` whenever you echo a specific origin; be careful with CDN caching of error responses.
- Plan for multi‑tenant allowlists and dynamic configuration if relevant.
- Implement correct preflight handling; use `Access-Control-Max-Age` to cache preflights when safe.

[Details and configuration examples](/docs/utils/cors-support)

---

## Better or just different?

You be the judge—and if you try it, tell me where it surprises you.

Want to try our approach? Start with [routeDORequest](/docs/utils/route-do-request) and [CORS configuration guide](/docs/utils/cors-support)
