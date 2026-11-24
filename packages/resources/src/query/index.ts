/**
 * The query engine: pure functions from an ontology's fields to SQL over stored resources.
 *
 * - {@link compileWhere} and {@link compileQuery} turn a filter into a WHERE clause.
 * - {@link compileIndex} turns an index specification into `CREATE INDEX` and `DROP INDEX`.
 * - {@link findUnqueryable} names the values a query would read wrongly.
 *
 * Each takes `TypeMetadata['fields']` from `extractTypeMetadata` as its ontology. None touches
 * storage; a host runs the SQL they return.
 */
export { QueryError } from './errors';
export { resolveField, fieldsOfType } from './fields';
export type { FieldInfo, FieldsMap, ResolvedField, ScalarKind } from './fields';
export { compileWhere, compileQuery, MAX_BOUND_PARAMS } from './where';
export type { Filter, CompiledWhere, CompiledQuery, SqlParam } from './where';
export { compileIndex, QUERY_INDEX_PREFIX, MAX_INDEX_FIELDS } from './indexes';
export type { IndexSpec, CompiledIndex } from './indexes';
export { findUnqueryable, assertQueryable } from './queryable';
export type { QueryableIssue } from './queryable';
