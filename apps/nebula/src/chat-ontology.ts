/**
 * The platform chat ontology's COMPILED seed — the server half of the pair whose pure
 * strings live in the client-safe `./chat-constants` leaf.
 *
 * The Galaxy INSTALLS its chat ontology into its own KV registry the way it installs
 * one for a Star ({@link Galaxy.#ensureChatFacet} — a versioned row, a derived
 * Worker-Loader `bundleId`, `OntologyStaleError` enforcement). This module supplies
 * only the FIRST install's content: {@link chatOntologySeedRow} returns the COMMITTED
 * precompiled row (`./validator-seeds`, emitted by `scripts/gen-validator-seeds.ts`) —
 * the input is a platform constant, so no Worker ever runs the compiler for it. There
 * is no per-boot re-compile and no hand-bumped bundle id — staleness is solved by
 * DERIVATION (the loader `bundleId` embeds the installed version label, and labels are
 * append-only + duplicate-rejected), exactly as `Star` already does.
 *
 * ⚠️ Keep it out of `client-index.ts` — the row embeds a ~30 KB validator module no
 * browser needs; clients take the version label from `./chat-constants`.
 */

import type { OntologyVersionRow } from './ontology-compile';
import { CHAT_ONTOLOGY_SEED_ROW } from './validator-seeds';

// Re-exported so server-side import sites can take the whole trio from one module.
export { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES } from './chat-constants';

/**
 * The platform chat ontology's installable row — the seed content for a Galaxy's FIRST
 * chat-ontology install. A committed precompiled literal (no runtime compile); the
 * platform relationship types (`_OrgNode`, `_InviteStatus`) were unioned in by the
 * generator's `compileOntologyVersion` like every version's.
 */
export function chatOntologySeedRow(): OntologyVersionRow {
  return CHAT_ONTOLOGY_SEED_ROW;
}
