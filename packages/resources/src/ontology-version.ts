/**
 * The ontology version a host installs: what is compiled (a config) and what is stored (the
 * compiled row). The compiler that turns one into the other runs in the build container
 * (`apps/nebula/src/ontology-compile.ts`), never in a Worker, so this module holds types only.
 */
import type { FieldsMap, IndexDeclaration, TypeMetadata } from '@lumenize/ts-runtime-parser-validator/compile';

export interface OntologyVersionConfig {
  version: string;
  types: string;
}

/**
 * Compiled, stored-per-version row. Immutable after write.
 *
 * `relationships` is stored beside `validatorBundle` so nothing re-extracts it: a lazy migrator
 * would read it on every cold migration.
 *
 * `fields` and `indexes` are what the query engine takes as its ontology (`src/query`): each
 * field's kind, and every index the types declare with `@index`. A host compiles a query's filter
 * from `fields`, and makes its indexes match `indexes` when it installs the row. Both are absent
 * from a row compiled before queries took a filter; a host holding one refuses every query, by a
 * message saying the app needs a build.
 */
export interface OntologyVersionRow {
  version: string;
  types: string;
  validatorBundle: string;
  relationships: TypeMetadata['relationships'];
  fields?: FieldsMap;
  indexes?: IndexDeclaration[];
}
