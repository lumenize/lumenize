---
slug: shoulders-of-giants
title: Standing on the Shoulders of Giants
authors: [larry]
tags: [personal]
---

## Kenton Varda

I started playing with DOs shortly before Kenton Varda (aka @kenton) published his now famous [Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/easy-fast-correct-choose-three/) post which introduced a high-consistency concurrency model via: 1) input gates, 2) output gates, and 3) storage cache. The good news was that this gave us a wonderful new way to build highly-scalable applications. The bad news was that it's such a radical departure from what we are used to doing, that it requires a huge mindset shift to take advantage of.

Over the next few years, <!-- truncate --> I developed apps, evolved my own base class, and wrote about my [favorite](https://medium.com/cloudflare-durable-objects-design-patterns/lazy-hydration-cab27e7c70b5) [patterns](https://medium.com/cloudflare-durable-objects-design-patterns/maintaining-consistent-state-56f5bb22dba9). 

## Sunil Pai

Then, I learned about PartyKit which is built by Sunil Pai (aka @threepointone) because he started talking about it as socket.io for DOs with reconnecting WebSockets on the #durable-objects Discord channel. Before I had the chance to do more than just play with PartyKit, he went to work for Cloudflare and shipped the `Agent` base class as part of the `agents` npm package. I immediately started using `Agent` and `routeAgentRequest` and fell in love with its patterns. However, I lost trust in `Agent` when I hit a [nasty security-relevant race-condition issue](https://github.com/cloudflare/agents/issues/321) that went unfixed for months. Since `Agent` was just a wrapper for `PartyServer`, I temporarily switched to it while I started creating Lumenize by forking parts of PartyKit.

## Brayden Wilmoth

I had been following Brayden Wilmoth (aka @Brayden)'s work before he came to work for Cloudflare. He is the creator of the Cloudflare D1 Data Explorer. He recently started working on the `Actor` base class, which is bringing DOs even closer to the [Actor programming model](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/#actor-programming-model). I'm a fan and am monitoring closely. My conversations with Brayden have been instrumental in shaping my understanding of how best to implement the Actor model on DOs even if Lumenize's take on that model is somewhat different.

## Lambros Petrou

Along the way, one person has helped me understand DOs more than perhaps everyone else combined, Lambros Petrou (aka @lambrospetrou). He's the author of the single most useful page in Cloudflare's documentation, [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and the wonderful [`durable-utils` npm package](https://www.npmjs.com/package/durable-utils), not to mention one of the most humble and patient people I know.

## Other Community Members

Besides Lambros and Brayden, off the top of my head, the following people have made the community on the #durable-objects Discord channel a better place: @Jun, @Milan, @Hard@Work|R2, @João, @Leo, @1984FordLaser, @Marak, and I'm sure there are some others I'm missing. I've learned something from every one of them and I'm proud to be part of the community that they anchor.

## Seeing Farther from Their Shoulders

I'm still learning and building, but I wouldn't have seen this far without standing on the shoulders of these giants.
