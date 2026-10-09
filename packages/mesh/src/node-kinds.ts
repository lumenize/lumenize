/**
 * The marks a node's class carries that Mesh's core reads. Every symbol in this module is private to
 * Mesh: none is exported from an entry, so no subclass can name, remove, override or forge one.
 *
 * - {@link PASSAGE_STEP} — the method the core runs before `onBeforeCall`, on both doors, on every
 *   call but the answers to a chain the node started. `ScopedMeshDO` puts its passage check there,
 *   so a subclass overriding `onBeforeCall` without `super` cannot drop it.
 * - {@link GATEWAY_PASSAGE} — the method a host's `ClientGateway` runs to check a Client's passage
 *   into a scoped node before sending the call on. For a call addressed to a Client it is the only
 *   passage check, since the receiving host hands it to its Gateway before any passage step runs.
 * - {@link REFUSES_SCOPE_NAME} — set by `UnscopedMeshDO`. The identity stamp every entry reaches,
 *   `lmz.__init`, then refuses a name that parses as a scope.
 */
export const PASSAGE_STEP = Symbol('lmz.passageStep');
export const GATEWAY_PASSAGE = Symbol('lmz.gatewayPassage');
export const REFUSES_SCOPE_NAME = Symbol('lmz.refusesScopeName');
