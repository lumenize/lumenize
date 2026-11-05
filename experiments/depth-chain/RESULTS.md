# Subrequest depth across a Client's answer

**Question.** On 2026-10-13 a deployed Galaxy logged `Subrequest depth limit exceeded` in `fireResponse`, called from `ClientGateway`'s `#deliverToClient`, inside a `__handleResponse` invocation. The Gateway awaits a Client's answer as a promise that a later WebSocket event resolves, then fires back. The suspicion was that the fire-back inherits the depth of the invocation that waited, so the chain never resets at a Client.

**Setup.** `experiment-depth-chain`, compatibility date 2026-10-01. A `Node` calls a `Host` over RPC; the Host acks and sends a frame down a real WebSocket to a Node.js client, which answers at once. The answer fires back to the Node, whose handler calls the Host again, for 40 rounds. Mode `held` fires back from the code that awaited the answer under `waitUntil`, as the Gateway does today; mode `fresh` fires back from the WebSocket event that carried the answer. `/pingpong` measures the limit: two objects calling each other, each call made from inside the handling of the last.

## Results (2026-10-14, deployed)

| Probe | Result |
|---|---|
| `/pingpong` | the 16th nested call failed (`reachedDepth: 7`: seven round trips below the entry call) |
| `held`, 40 rounds | all 40 completed, no depth error |
| `fresh`, 40 rounds | all 40 completed, no depth error |

1. **The depth limit is 16 nested calls.** Cloudflare does not document it.
2. **A Client's answer resets the chain in today's Gateway.** Code awaiting a promise that a WebSocket event resolves runs in that event's context, so its RPC starts from that event's depth. Firing back from the answer's own event (`fresh`) changes nothing.
3. **So the 2026-10-13 error came from somewhere else.** A delivery that ends with no Client answer, because there is no socket, a grace period runs out, or the 30 s timeout fires, fires back from the invocation that started it, and nothing resets the depth there. A chain of node-to-node fire-backs, each handler calling on from inside the last, through such a delivery is the remaining candidate. It is unmeasured.

## What the 2026-10-13 error was (found 2026-10-14)

It recurred on `test-nebula` during `resubscribe-when-lost`, whose limb 1 closes a Studio tab while a turn streams to it, and its failure line, which now names its chain, read `to: GALAXY/<galaxy>` with a chain of just that Galaxy and its Client. Workers Logs, queried by the trace id, showed the rest:

1. **Each chunk the Galaxy pushed to the gone tab came back as a self-RPC.** The Gateway delivers a node's call to a Client the node hosts in place, but sent the answer, here `ClientDisconnectedError`, to the node's own `__handleResponse` through a stub, so each answer was a new invocation.
2. **Each new invocation sat one level inside the last.** The thirteen chunk answers after the close ran as thirteen `__handleResponse` invocations, each nested in the one before, and every chunk after the thirteenth failed with the depth error, logged from inside the last. Why the turn's loop kept continuing inside the newest invocation is not established; the nesting itself is what the logs show.
3. **The failed answers included the reaper's**, so the tab's subscriber row was never dropped, which is how the scenario failed.

The fix, in `@lumenize/mesh`: the Gateway hands the answer to its host's own door in place, as a node already does for a Client it hosts, so no answer to a node from itself crosses an RPC.
