# Which log lines reach `wrangler tail`, and which reach Workers Logs

**Question.** On 2026-10-14 a deployed `scope-teardown` run never saw the Galaxy's own `tearing down` line for a deletion, while the facade's lines around it arrived. A raw `wrangler tail --format json` beside a second run lacked it too, so the harness's parser was not at fault. Workers Issues had recorded that invocation, with the line in its trail. The Galaxy was mid-turn when it was deleted, while every Galaxy torn down idle delivered its line. Does the tail lose the event of an invocation that `ctx.abort()` ends while other work on the object is in flight, and does Workers Logs do better?

**Setup.** `experiment-tail-abort`, compatibility date 2026-10-01, Workers Issues on and, from run 3, Workers Logs. Each probe object takes on one kind of in-flight work, then an RPC logs `killing` and aborts, as `ScopedMeshDO.teardown` does. The kinds are `idle` (nothing), `timer` (a `waitUntil` holding a 60 s timer), `fetch` (a `waitUntil` holding a 25 s subrequest, as a model stream does), `rpc` (an earlier RPC still awaiting a 25 s subrequest), and `socket` (a hibernatable WebSocket open). `scripts/drive.mjs` runs a raw tail beside them and reports which `killing` lines arrived; Issues and Workers Logs were read afterwards by API.

## Results (2026-10-14, deployed)

Three runs, 70 kills; 2 kills in run 1's first round never ran (no Issues occurrence, no line anywhere), leaving 68.

| Kills whose line was missing from | idle | timer | fetch | rpc | socket | total |
|---|---|---|---|---|---|---|
| `wrangler tail` | 0 of 14 | 1 of 13 | 1 of 13 | 2 of 14 | 0 of 14 | **4 of 68** |
| Workers Issues (and Workers Logs, run 3) | 4 | 0 | 0 | 1 | 1 | **6 of 68** |
| both | 0 | 0 | 0 | 0 | 0 | **0** |

1. **The tail loses an aborted invocation's event when other work on the object is in flight.** All four of its misses had a `waitUntil` or a pending RPC; it delivered every idle and socket-holding kill. When it lost one, it sometimes lost the object's earlier `hold` event too. It reported no `overload` notice, so this is not its sampling mode.
2. **Workers Issues and Workers Logs lose events too, and different ones.** Six kills reached the tail and are absent from Issues; in run 3, Workers Logs and Issues lacked the same two. Workers Logs also lacked one ordinary, un-aborted `hold` line out of 24. So neither channel is complete, and in 68 kills no line was lost by both.
3. **The tail delivers an invocation's lines only when it ends, and a WebSocket upgrade ends when its socket closes.** Seen in the raw tail beside `scope-teardown`: a Star's upgrade event, holding its `onStart` and `WebSocket connection accepted` lines, arrived after the socket's close with outcome `responseStreamDisconnected`. A scenario waiting for an accept line on a socket it keeps open waits until it closes the socket.
4. **The tail's loss is certain, not occasional, when the aborted object hosts live tabs.** Nebula's `scope-hosts-its-clients`, deployed three times on 2026-10-14: its Star is founded and then deleted while it hosts tabs, and in every run the tail lacked that Star's upgrade lines and both teardowns. Unlike the probe's idle socket, those tabs were live, and the abort cut off their close handlers: Issues recorded each one as an aborted `webSocketClose`. Workers Issues recorded both teardowns, and Workers Logs, on for the third run, held every one of those lines.
5. **Workers Logs lags, and by a varying amount.** Three probe lines, written one at a time and queried every few seconds, appeared after 29 s, after 322 s, and somewhere between 300 s and 570 s. A reader that falls back to Workers Logs for a line the tail dropped waits up to about ten minutes.
