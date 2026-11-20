/**
 * How a query reaches one field of a stored resource.
 *
 * A snapshot's `value` column holds the structured-clone text of the resource. That text keeps a
 * string, a finite number and a boolean as plain JSON, and wraps the rest: a `Date` as
 * `{"$type":"date","iso":"…"}`, `null` as `{"$type":"null"}`, `Infinity` as
 * `{"$type":"number-special",…}`. So `json_extract(value, '$.stage')` reads a string field, and a
 * `Date` field is read one step deeper, at `$.due.iso`.
 *
 * This file is the one place that knows those shapes. The WHERE compiler and the index compiler
 * both build their SQL from {@link resolveField}, so a query's clause and an index's expression are
 * the same text, which is what lets SQLite use the index. `test/query/stored-form.test.ts` pins
 * each shape against the serializer, so a change to how a value is stored reds here first.
 */
import type { FieldInfo, FieldsMap } from '@lumenize/ts-runtime-parser-validator/compile';
import { END_OF_TIME } from '../snapshots';
import { QueryError } from './errors';

export type { FieldInfo, FieldsMap };

/** The kinds a clause can compare, each read as one SQL scalar. */
export type ScalarKind = 'string' | 'number' | 'boolean' | 'date' | 'id' | 'enum';

/** One field of one type, resolved for SQL. */
export interface ResolvedField {
  /** The dotted path as the query wrote it, `address.city`. */
  path: string;
  info: FieldInfo;
  /** The SQL that reads the field's value: `json_extract(value, '$.address.city')`. */
  sql: string;
  /** SQL that is true only when the field holds a value of its declared type. */
  holdsValueSql: string;
}

/** A property name a JSON path can carry unquoted, which keeps every path free of a quote. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A type's name, which reaches SQL as a literal and so is held to the same shape. */
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `json_type` answers for a stored value of each kind. */
const JSON_TYPES: Record<ScalarKind, string> = {
  string: `'text'`, id: `'text'`, enum: `'text'`, date: `'text'`,
  number: `'integer', 'real'`,
  boolean: `'true', 'false'`,
};

/** The fields of `typeName`, or a refusal naming the type. */
export function fieldsOfType(fields: FieldsMap, typeName: string): Record<string, FieldInfo> {
  const own = Object.hasOwn(fields, typeName) ? fields[typeName] : undefined;
  if (!own || !TYPE_NAME.test(typeName)) {
    throw new QueryError(`The ontology has no type named "${typeName}"`, typeName);
  }
  return own;
}

/**
 * Resolve a dotted path against the ontology, refusing a name the type does not declare.
 *
 * The ontology is the allow-list: a path reaches SQL only as text built here from names it
 * declares, so nothing a caller sends is ever interpolated.
 */
export function resolveField(fields: FieldsMap, typeName: string, path: string): ResolvedField {
  let level = fieldsOfType(fields, typeName);
  const parts = path.split('.');
  let info: FieldInfo | undefined;
  for (const [i, part] of parts.entries()) {
    info = Object.hasOwn(level, part) ? level[part] : undefined;
    const soFar = parts.slice(0, i + 1).join('.');
    if (!info) throw new QueryError(`${typeName} has no field "${soFar}"`, path);
    if (!PLAIN_NAME.test(part)) {
      throw new QueryError(`${typeName}.${soFar} cannot be queried: its name is not a plain identifier`, path);
    }
    if (i < parts.length - 1) {
      if (info.kind !== 'object') {
        throw new QueryError(`${typeName}.${soFar} has no fields of its own to reach into`, path);
      }
      level = info.fields;
    }
  }
  const resolved = info!;
  if (resolved.kind === 'unsupported') {
    throw new QueryError(`${typeName}.${path} cannot be queried: it is ${resolved.reason}`, path);
  }
  const jsonPath = `$.${parts.join('.')}`;
  if (resolved.kind === 'object') {
    // A wrapped value, `null` among them, is an object carrying `$type`; a real one carries none.
    return {
      path, info: resolved, sql: `json_extract(value, '${jsonPath}')`,
      holdsValueSql: `(json_type(value, '${jsonPath}') = 'object' AND json_type(value, '${jsonPath}."$type"') IS NULL)`,
    };
  }
  const valuePath = resolved.kind === 'date' ? `${jsonPath}.iso` : jsonPath;
  return {
    path, info: resolved, sql: `json_extract(value, '${valuePath}')`,
    holdsValueSql: `json_type(value, '${valuePath}') IN (${JSON_TYPES[resolved.kind]})`,
  };
}

/**
 * The SQL that selects a type's current rows. A query's WHERE and an index's WHERE both start with
 * exactly this text, so SQLite sees at a glance that the query's rows are the index's. The type
 * and the end-of-time sentinel are literals because an index's WHERE takes no parameters; the type's
 * name comes from the ontology and is a plain identifier.
 */
export function currentRowsSql(fields: FieldsMap, typeName: string): string {
  fieldsOfType(fields, typeName);
  return `typeName = '${typeName}' AND validTo = '${END_OF_TIME}' AND deleted = 0`;
}
