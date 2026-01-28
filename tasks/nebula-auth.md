It occurs me that the current security model for Lumenize Mesh (packages/mesh, website/docs/mesh) has a huge hole in it. We have the most coarse granularity security you can imagine in that you must be authenticated to enter the mesh. However, anyone with an email can be authenticated with our current auth. We have two layers of fine-grained access control, onBeforeCall and @mesh(guard?).

I believe that we need one layer of granularity in between. I believe there must have some sort of allowlist in addition to being authenticated before we allow someone into the mesh.

I want to start a new docs-first task-management command/process to plan this work in a new task file and with a set of docs revisions.

Here's what I'm thinking...

I believe that our current @lumenize/auth only has the concept of a user defined by their email address. I'm not even sure if we keep that list long term. We may only keep it until the refresh token expires.

Only super-admin, admin, and member... or maybe user or participant. A super-admin is both an admin and a member. An admin is both an admin and a member. We should decide on user vs member vs participant vs some other term. I would love a term that could apply to humans and non-humans (agents, other services, etc.).

Bootstrap super-admin by specifying the email address of one or more super-admins with an environment variable. Provide an endpoint to add admins or members. Super-admins can add admins or members. Admins can only add members.

I also want to upgrade the system to explicitly support the idea of an agent, system, or human impersonating a human. I want logging to appear as `{ member: 'memberId', impersonatedBy: 'agentId' }` where the impersonatedBy is optional. Permissions are determined by member's permissions. However, this has a potentially deeper impact on the mesh design (particularly callContext) and could even be done as a separate task later.

I also want to upgrade the data model for members. I want a single real person to be able to have multiple email addresses and each email address can be a member of multiple organizations. In theory, the same person can be a member of the same organization more than once under different email addresses. That's an edge case we'll have to address. First thought, that's three SQL tables: Person, Organization, and EmailAddress with the appropriate foreign keys.

Organizations are defined by a universe.galaxy.star. It cooresponds to the prefix to their instanceName for LumenizeDOs and LumenizeClients. Clients get to specify this instanceName. They will only be allowed to connect if the member indicated by their access token has access to that universe.galaxy.star. I'm hoping we can embed the full list of universe.galaxy.star orgs in the JWT claims.

@lumenize/auth clean boundary.

The key to keeping this a clean upgrade from @lumenize/auth is onBeforeCall. The default onBeforeCall for LumenizeDO will look for an environment variable flag. If the flag indicates Lumenize Nebula, then for LumenizeDOs and LumenizeClient, it will look at the caller and callee's instanceNames and only allow the call if they match the universe.galaxy.star prefix. I think LumenizeWorker's onBeforeCall remains a no-op in this model but that's OK since they have no storate to keep private.

JWT claims

BSL 1.1 licensed

Maybe a callback to existing auth for setting claims?

Extend LumenizeDO to NebulaDO
