/**
 * The two marks a node's class carries that the core reads, private to Mesh: neither is exported
 * from an entry, so no subclass can name, remove or forge them.
 *
 * - {@link PASSAGE_STEP} — the method the core runs before `onBeforeCall`, on both doors, on every
 *   call but the answers to a chain the node started. `ScopedMeshDO` puts its passage check there,
 *   so a subclass overriding `onBeforeCall` without `super` cannot drop it.
 * - {@link REFUSES_SCOPE_NAME} — set by `UnscopedMeshDO`. The identity stamp every entry reaches,
 *   `lmz.__init`, then refuses a name that parses as a scope.
 */
export const PASSAGE_STEP = Symbol('lmz.passageStep');
export const REFUSES_SCOPE_NAME = Symbol('lmz.refusesScopeName');
