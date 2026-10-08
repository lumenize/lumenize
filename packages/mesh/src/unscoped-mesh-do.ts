/**
 * UnscopedMeshDO — the Durable Object base of a node named by an id rather than a scope: a person's
 * `Profile`, named by its `profileId`, or a document named by a UUID.
 *
 * It runs no passage check, so each method decides who may call it, and it never runs under a name
 * that parses as a scope. Passage reads a claimless chain's scope from the name of the node that
 * started it, which is sound only if every object under a scope-shaped name checks passage into
 * that scope. So the identity stamp every entry reaches, `lmz.__init`, refuses such a name here: a
 * mesh call, a routed request and a `rawRpcStub` first touch alike. Not in `onBeforeCall`, which a
 * subclass can override, nor in the constructor, since a throwing Durable Object constructor hangs
 * the test pool.
 *
 * ⚠️ **A node that holds anyone's data is its own gatekeeper, both ways.** Nothing checks passage
 * into it, and a Client's host checks nothing for a push from it, since its name offers no scope to
 * check passage into (`requirePassageIntoSender`). So it guards `subscribe` against its own list of
 * who may read, and checks that list again before each push.
 *
 * It carries `svc`, alarms and `onStart`, and hosts no Clients and has no `teardown`.
 */
import { MeshDO } from './mesh-do';
import { REFUSES_SCOPE_NAME } from './node-kinds';

export abstract class UnscopedMeshDO<Env = any> extends MeshDO<Env> {
  /** @internal Read by `lmz.__init`, which refuses a scope-shaped name for this node. */
  get [REFUSES_SCOPE_NAME](): true {
    return true;
  }
}
