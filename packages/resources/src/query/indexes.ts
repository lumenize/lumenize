/**
 * Compile an index specification to the SQL that creates and drops it.
 *
 * `{ type: 'Deal', fields: ['stage', 'amount'] }` becomes an index on two expressions over the
 * `value` column, limited to `Deal`'s current rows. Each expression is the text
 * {@link compileWhere} writes for the same field, and the index's WHERE is the text
 * {@link compileQuery} opens with, so SQLite matches a query to its index by reading them.
 *
 * An index costs one more row written for each write of the type (`durable-objects.md`
 * § *SQLite write-cost optimization*), and a field with no index still filters, by a scan of the
 * type's current rows.
 */
import { QueryError } from './errors';
import { currentRowsSql, resolveField } from './fields';
import type { FieldsMap } from './fields';

/** One index: a type, and its fields in order, the leftmost serving a query on it alone. */
export interface IndexSpec {
  type: string;
  /** Dotted paths, `stage` or `address.city`. */
  fields: string[];
}

export interface CompiledIndex {
  /** Unique to the type and its fields in order, so the same specification always names one index. */
  name: string;
  createSql: string;
  dropSql: string;
}

/** Every query index's name starts with this, so a host can list its own in `sqlite_master`. */
export const QUERY_INDEX_PREFIX = 'idx_Snapshots_q_';

/** The most fields one index may carry. */
export const MAX_INDEX_FIELDS = 8;

/**
 * @throws QueryError when the type or a field is not in the ontology, a field is one a query cannot
 * compare, or the list is empty, repeats a field, or is longer than {@link MAX_INDEX_FIELDS}.
 */
export function compileIndex(fields: FieldsMap, spec: IndexSpec): CompiledIndex {
  const rows = currentRowsSql(fields, spec.type);
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new QueryError(`An index on ${spec.type} names at least one field`, spec.type);
  }
  if (spec.fields.length > MAX_INDEX_FIELDS) {
    throw new QueryError(`An index on ${spec.type} names ${spec.fields.length} fields, and may name ${MAX_INDEX_FIELDS}`, spec.type);
  }
  const seen = new Set<string>();
  const expressions = spec.fields.map((path) => {
    if (seen.has(path)) throw new QueryError(`An index on ${spec.type} names "${path}" twice`, path);
    seen.add(path);
    const field = resolveField(fields, spec.type, path);
    if (field.info.kind === 'object') {
      throw new QueryError(`${spec.type}.${path} holds an object, which an index cannot order. Index one of its fields, "${path}.name"`, path);
    }
    return field.sql;
  });
  // Type and field names are plain identifiers, so the name needs no escaping inside its quotes.
  const name = `${QUERY_INDEX_PREFIX}${spec.type}:${spec.fields.join(',')}`;
  return {
    name,
    createSql: `CREATE INDEX IF NOT EXISTS "${name}" ON Snapshots(${expressions.join(', ')}) WHERE ${rows}`,
    dropSql: `DROP INDEX IF EXISTS "${name}"`,
  };
}
