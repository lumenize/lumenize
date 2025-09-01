---
slug: shoulders-of-giants
title: Standing on the Shoulders of Giants
authors: [larry]
tags: [personal]
---

I started playing with DOs shortly before Kenton Varda (aka @kenton) published his now famous [Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/easy-fast-correct-choose-three/) post which introduced a high-consistency concurrency model via: 1) input gates, 2) output gates, and 3) storage cache. The good news was that this gave us a wonderful new way to build highly-scalable applications. The bad news was that it's such a radical departure from what we are used to doing, that it requires a huge mindset shift to take advantage of.

Over the next few years, <!-- truncate --> I developed apps, evolved a mature base class, and wrote about my [favorite](https://medium.com/cloudflare-durable-objects-design-patterns/lazy-hydration-cab27e7c70b5) [patterns](https://medium.com/cloudflare-durable-objects-design-patterns/maintaining-consistent-state-56f5bb22dba9). 

Then, I learned about PartyKit which is built by Sunil Pai (aka @threepointone) because he started talking about it as socket.io for DOs with reconnecting WebSockets. Before I could start using it, he went to work for Cloudflare and shipped that `Agent` base class as part of the `agents` npm package. I immediately switched to using `Agent` and `routeAgentRequest` and fell in love with its patterns.
q