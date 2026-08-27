/**
 * The platform chat ontology's COMPILED seed — the server half of the pair whose pure
 * strings live in the client-safe `./chat-constants` leaf.
 *
 * The Galaxy INSTALLS its chat ontology into its own KV registry the way it installs
 * one for a Star ({@link Galaxy.#ensureChatFacet} — a versioned row, a derived
 * Worker-Loader `bundleId`, `OntologyStaleError` enforcement). This module supplies
 * only the FIRST install's content: {@link chatOntologySeedRow} compiles
 * `CHAT_MESSAGE_TYPES` at `CHAT_MESSAGE_ONTOLOGY_VERSION`. There is no per-boot
 * re-compile and no hand-bumped bundle id — staleness is solved by DERIVATION (the
 * loader `bundleId` embeds the installed version label, and labels are append-only +
 * duplicate-rejected), exactly as `Star` already does.
 *
 * ⚠️ NOT browser-safe — `compileOntologyVersion` pulls the bundled tsc/typia deps
 * (multi-MB, Node/workerd only). Keep it out of `client-index.ts`; clients take the
 * version label from `./chat-constants`.
 */

import { compileOntologyVersion } from './ontology-compile';
import type { OntologyVersionRow } from './ontology-compile';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES } from './chat-constants';

// Re-exported so server-side import sites can take the whole trio from one module.
export { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES } from './chat-constants';

/**
 * Compile the platform chat ontology to its installable row — the seed content for a
 * Galaxy's FIRST chat-ontology install. Runs once per Galaxy (the installed row is
 * durable); the platform relationship types (`_OrgNode`, `_InviteStatus`) arrive via
 * `compileOntologyVersion`'s `PLATFORM_RESOURCE_TYPES` union like every version.
 */
export function chatOntologySeedRow(): OntologyVersionRow {
  return compileOntologyVersion({
    version: CHAT_MESSAGE_ONTOLOGY_VERSION,
    types: CHAT_MESSAGE_TYPES,
  });
}
