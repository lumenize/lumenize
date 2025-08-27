- [x] I noticed that you slipped back into using async/await. The only place we should need that is in externally facing handlers. Everything else should be synchronous including database operations.

- [x] We currently store the originalUri with the subscription. I think it's fine to leave it in there in case we need it later, but do we currently ever use that?

- [x] Similarly, does the subscription table now include three fields sessionId, entityId, and subscriptionType?

- [x] In lumenize-server.ts, in the handleCallTool method, there are two different ways that errors are handled. One is to throw an error, and the other is to return an object with an error property. Is there a reason for this inconsistency? Should we standardize on one approach?

- [x] In the entity-types.ts file, the #entityTypeRegistry is current an in-memory Map. We need to change that to immediately store in storage and always load from storage when we need to access it. This will ensure that entity types persist across Durable Object restarts.
