# Nebula Auth

## Context

This is currently a scratchpad of thinking about the Nebula auth which will be an extension or adaptation of @lumenize/auth which is currently being upgraded to support isSuperAdmin, isAdmin, and hasMeshAccess. The upgraded @lumenize/auth also includes upgraded onBeforeConnect/onBeforeRequest hook functions that require hasMeshAccess.

Nebula is a BSL 1.1 licensed vibe coding platform (back and front end) built on Lumenize Mesh except it's coded through it's APIs which may include sandboxed user-provided code using Cloudflare's new Dynamic Worker Loader (DWL) feature.

## Data Model

I want a single real person to be able to have multiple email addresses and each email address can be a member of multiple organizations. This means that the same real person can be a member of the same organization more than once under different email addresses. I think that's OK but may require more thought. First thought on the data model is that there are three SQL tables: Person, Organization, and EmailAddress with the appropriate foreign keys.

## `universe.galaxy.star` (aka `starId`) Multitenancy

Organizations are defined by a `universe.galaxy.star` (aka `starId`). It cooresponds to the prefix to their instanceName for LumenizeDOs and LumenizeClients. Clients get to specify this instanceName. The instanceName ends up in the URL for LumenizeClients. In onBeforeConnect/onBeforeRequest, we'll inspect both the url and the JWT claims and if the url segment for `starId` doesn't match the allowed list in the JWT, we'll throw.

I'm hoping we can embed the full list of `starId`s in the JWT claims but will need to consider the practical limits.

## `starId` Format Constraints

`starId` will be made up for three url-friendly slugs separated by periods. Slugs will have to be limited to not having periods and probably should be more limited than that (only lowercase, numbers, and "-" allowed).

Universe will be globally unique. Galaxy unique within that Universe. Star unique within that Galaxy. For Universe, maybe a convention riffing off of their domain would make sense (e.g. lumenize-com for lumenize.com).

## Clean Upgrade From `@lumenize/auth`

We'll swap out the auth system which also conveniently provides the onBeforeConnect/onBeforeRequest hook functions. We may need to upgrade the expected headers though (currently user and claims). We may need one for the `starId`. Also, the user one will probably be switched during the @lumenize/auth upgrade. We're adopting the RFC's sub and act.sub convention.

## `callContext` Upgrade

The `starId` will be in the instanceName property of callContext.callChain[0] if the call originated from a Client. However, you can create a new callChain with `{ newCallChain: true }` and calls might originate from a non-Client, like in an alarm handler, so we need another immutable property in callContext for `starId` that is available in all three node mesh types. A particular mesh DO will keep it in storage and will only ever be part of one `starId`. Same thing for Client/Gateway but it's kept in memory and the WS attachment instead of DO storage. For Workers, the `starId` will come from the caller, and outgoing calls will have to propogate that.

My first thought on how to accomplish this is with NebulaDO, NebulaWorker, NebulaClient, and NebulaClientGateway classes that extend the Lumenize* equivalents and override the default onBeforeCall, callContext, and maybe even call itself so only calls within the same `starId` will be allowed. Remember, users won't be extending these and deploying them.

## Security Questions

- How do we prevent someone from forging a callContext `starId` in a direct Workers RPC call? Actually, I don't think this is a big problem because Nebula is a not a developer paltform like Lumenize Mesh. It's only used through APIs, which may include sandboxed user-provided functions using Cloudflare's new Dynamic Worker Loader (DWL) feature, but won't include other user-provided code. We'll just have to make sure the user-provided code is constrained to a paricular starId. We may just need to give the code in the sandbox a wrapped version of call.
