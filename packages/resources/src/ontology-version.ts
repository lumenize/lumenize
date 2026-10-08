/**
 * The ontology version a host installs: what is appended (a config) and what is stored (the
 * compiled row). The compiler that turns one into the other runs in the build container
 * (`apps/nebula/src/ontology-compile.ts`), never in a Worker, so this module holds types only.
 */
import type { TypeMetadata } from '@lumenize/ts-runtime-parser-validator/compile';

export interface OntologyVersionConfig {
  version: string;
  types: string;
  /**
   * Whether a Star INSTALLING this version over an older one must wipe its data first (the
   * breaking-edit bargain — a breaking ontology edit invalidates stored snapshots, which are
   * never migrated pre-alpha). A PROPERTY of the version row, decided (and dominion-checked)
   * where the version is appended — written once, immutable, never consumed-and-cleared. A
   * Star already on the version never asks (install is idempotent).
   */
  wipeOnInstall?: boolean;
}

/**
 * Compiled, stored-per-version row. Immutable after write.
 *
 * `relationships` is stored beside `validatorBundle` so nothing re-extracts it: `Resources` reads it
 * to validate a `parentChild` query (`installedOntology()`), and a lazy migrator would read it on
 * every cold migration.
 */
export interface OntologyVersionRow {
  version: string;
  types: string;
  validatorBundle: string;
  relationships: TypeMetadata['relationships'];
  /** See {@link OntologyVersionConfig.wipeOnInstall} — carried onto the immutable row. */
  wipeOnInstall?: boolean;
}
