/**
 * Compile a MongoDB-style filter to a SQLite WHERE clause over a type's stored resources.
 *
 * `{ stage: 'open', amount: { $gt: 1000 } }` on `Deal` becomes
 * `(json_extract(value, '$.stage') = ? AND (json_extract(value, '$.amount') > ? AND …))` with the
 * values bound, never interpolated. The operator set and the filter's shape follow Larry
 * Maccherone's sql-from-mongo (https://github.com/lmaccherone/sql-from-mongo), which targeted
 * Azure DocumentDB's SQL; this targets SQLite, binds its values, and reads each field's type from
 * the ontology.
 *
 * What a clause means, where SQL and a document store differ:
 *
 * - **A field "holds a value" when it is present with a value of its declared type.** Absent,
 *   `null` and `undefined` all count as no value. `{ f: null }` and `{ f: { $exists: false } }`
 *   both select those, and `$exists: true` the rest.
 * - **`$ne`, `$nin`, `$not` and `$nor` also match a resource whose field holds no value,** as they
 *   do in MongoDB. In plain SQL a comparison with NULL is unknown and drops the row.
 * - **An ordering operator matches only a field that holds a value,** so a `null` amount is neither
 *   above nor below 1000.
 * - **A string compares by its UTF-8 bytes,** so `"Zeta" < "alpha"`.
 *
 * Everything the engine cannot do is refused here, by message, before any SQL exists: a field the
 * type does not declare, an array or a `Map`, an ordering comparison on a union of string
 * literals, a value of the wrong type.
 *
 * **A query must give an index something to look up.** {@link compileQuery} refuses a filter that
 * would read every current resource of the type. A condition an index can look up is equality,
 * `$in`, a range or `$startsWith`, on the first field of one of the type's indexes, standing at the
 * filter's top level or inside a top-level `$and`. The rest of the filter then tests only the rows
 * that lookup found, so `$ne`, `$nin`, `$not`, `$nor`, `$exists`, `null`, `$endsWith` and
 * `$contains` are all fine beside one, and refused alone. `{}` is the one exception: it asks for
 * every resource of the type, and says so.
 */
import { QueryError } from './errors';
import { currentRowsSql, resolveField } from './fields';
import type { FieldsMap, ResolvedField, ScalarKind } from './fields';
import type { IndexSpec } from './indexes';

/** A filter: field paths and `$and` / `$or` / `$nor` / `$not`, each mapped to a condition. */
export type Filter = { [pathOrOperator: string]: unknown };

/** A bound value. SQLite has no boolean, so a boolean is bound as 1 or 0. */
export type SqlParam = string | number;

export interface CompiledWhere {
  /** The clause, or `''` for a filter with no conditions. */
  sql: string;
  params: SqlParam[];
}

/**
 * The most values one statement may bind in a Durable Object's SQLite.
 * `test/query/query-sqlite.test.ts` holds it against the running limit.
 */
export const MAX_BOUND_PARAMS = 100;

const ORDERING: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

/** The last UTF-16 unit a prefix may end in and still be a key range: below the surrogates. */
const RANGE_PREFIX_LIMIT = 0xd7ff;
const ARRAY_OPERATORS = new Set(['$elemMatch', '$size', '$all']);
const FIELD_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$not',
  '$startsWith', '$endsWith', '$contains',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function show(v: unknown): string {
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()})`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' || v === undefined) return String(v);
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

class Compilation {
  readonly params: SqlParam[] = [];
  constructor(readonly fields: FieldsMap, readonly typeName: string) {}

  filter(filter: unknown, where: string): string {
    if (!isPlainObject(filter)) {
      throw new QueryError(`A filter is an object of fields and conditions; ${where} is ${show(filter)}`, where);
    }
    const keys = Object.keys(filter);
    if (keys.length === 0) throw new QueryError(`${where} is an empty filter, which selects nothing in particular`, where);
    const parts = keys.map((key) => (key.startsWith('$') ? this.logical(key, filter[key]) : this.field(key, filter[key])));
    return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
  }

  logical(operator: string, operand: unknown): string {
    if (operator === '$not') return `((${this.filter(operand, '$not')}) IS NOT TRUE)`;
    if (operator !== '$and' && operator !== '$or' && operator !== '$nor') {
      throw new QueryError(`${operator} is not an operator a filter can open with; use $and, $or, $nor or $not`, operator);
    }
    if (!Array.isArray(operand) || operand.length === 0) {
      throw new QueryError(`${operator} takes a list of filters, and got ${show(operand)}`, operator);
    }
    const parts = operand.map((each, i) => this.filter(each, `${operator}[${i}]`));
    if (operator === '$and') return `(${parts.join(' AND ')})`;
    const any = `(${parts.join(' OR ')})`;
    return operator === '$or' ? any : `(${any} IS NOT TRUE)`;
  }

  field(path: string, condition: unknown): string {
    const field = resolveField(this.fields, this.typeName, path);
    if (condition === null) return `(${field.holdsValueSql} IS NOT TRUE)`;
    if (!isPlainObject(condition)) return this.operator(field, '$eq', condition);
    const keys = Object.keys(condition);
    const operators = keys.filter((key) => key.startsWith('$'));
    if (keys.length === 0 || operators.length !== keys.length) {
      throw new QueryError(
        `${this.typeName}.${path} is compared with ${show(condition)}. Compare a field with a value or with ` +
        `operators such as { $gt: 5 }, and reach a field inside it by a dotted path, "${path}.name"`, path);
    }
    const parts = keys.map((key) => this.operator(field, key, condition[key]));
    return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
  }

  operator(field: ResolvedField, operator: string, operand: unknown): string {
    const named = `${this.typeName}.${field.path}`;
    if (operator === '$exists') {
      if (typeof operand !== 'boolean') throw new QueryError(`$exists takes true or false, and ${named} got ${show(operand)}`, field.path);
      return operand ? field.holdsValueSql : `(${field.holdsValueSql} IS NOT TRUE)`;
    }
    if (operator === '$not') {
      if (!isPlainObject(operand) || Object.keys(operand).length === 0 || !Object.keys(operand).every((key) => key.startsWith('$'))) {
        throw new QueryError(`$not on ${named} takes operators, such as { $not: { $gt: 5 } }, and got ${show(operand)}`, field.path);
      }
      return `(${this.field(field.path, operand)} IS NOT TRUE)`;
    }
    if (ARRAY_OPERATORS.has(operator)) {
      throw new QueryError(`${operator} on ${named}: a query cannot look inside an array yet`, field.path);
    }
    if (!FIELD_OPERATORS.includes(operator)) {
      throw new QueryError(`${operator} on ${named} is not an operator this engine knows. It knows ${FIELD_OPERATORS.join(', ')}`, field.path);
    }
    const kind = field.info.kind;
    if (kind === 'object' || kind === 'unsupported') {
      throw new QueryError(
        `${named} holds an object, so it takes only $exists or null. Compare one of its fields by a dotted path, "${field.path}.name"`,
        field.path);
    }
    if (operator === '$eq') return `${field.sql} = ${this.bind(field, kind, operator, operand)}`;
    if (operator === '$ne') return `${field.sql} IS NOT ${this.bind(field, kind, operator, operand)}`;
    if (operator === '$in' || operator === '$nin') {
      if (!Array.isArray(operand)) throw new QueryError(`${operator} on ${named} takes a list of values, and got ${show(operand)}`, field.path);
      if (operand.length === 0) return operator === '$in' ? '0 = 1' : '1 = 1';
      const list = operand.map((each) => this.bind(field, kind, operator, each)).join(', ');
      return operator === '$in' ? `${field.sql} IN (${list})` : `(${field.sql} IS NULL OR ${field.sql} NOT IN (${list}))`;
    }
    if (operator in ORDERING) {
      if (kind === 'enum') {
        throw new QueryError(
          `${operator} on ${named}: its values are a fixed list, and comparing them by the order they are declared in is not built yet. Use $in with the values you mean`,
          field.path);
      }
      if (kind === 'boolean' || kind === 'id') {
        throw new QueryError(`${operator} on ${named}: ${kind === 'id' ? 'an id' : 'a boolean'} has no order to compare by`, field.path);
      }
      const compare = `${field.sql} ${ORDERING[operator]} ${this.bind(field, kind, operator, operand)}`;
      // A date is read at `.iso`, which a wrapped `null` does not have, so it needs no guard.
      return kind === 'date' ? compare : `(${compare} AND ${field.holdsValueSql})`;
    }
    // $startsWith, $endsWith, $contains
    if (kind !== 'string') throw new QueryError(`${operator} on ${named} needs a string field, and ${named} is ${kind === 'enum' ? 'a fixed list of values' : `a ${kind}`}`, field.path);
    if (typeof operand !== 'string') throw new QueryError(`${operator} on ${named} takes a string, and got ${show(operand)}`, field.path);
    if (operand === '') return field.holdsValueSql;
    const length = [...operand].length;
    if (operator === '$contains') return `(instr(${field.sql}, ${this.push(operand)}) > 0 AND ${field.holdsValueSql})`;
    if (operator === '$endsWith') return `(substr(${field.sql}, -${this.push(length)}) = ${this.push(operand)} AND ${field.holdsValueSql})`;
    const last = operand.charCodeAt(operand.length - 1);
    if (last < RANGE_PREFIX_LIMIT) {
      // A prefix is a key range, which an index can serve: from the prefix up to, and not including,
      // the prefix with its last character raised by one.
      const upper = operand.slice(0, -1) + String.fromCharCode(last + 1);
      return `(${field.sql} >= ${this.push(operand)} AND ${field.sql} < ${this.push(upper)} AND ${field.holdsValueSql})`;
    }
    return `(substr(${field.sql}, 1, ${this.push(length)}) = ${this.push(operand)} AND ${field.holdsValueSql})`;
  }

  /** Check `value` against the field's kind, bind it, and answer its placeholder. */
  bind(field: ResolvedField, kind: ScalarKind, operator: string, value: unknown): string {
    const named = `${this.typeName}.${field.path}`;
    const wrong = (expected: string) => new QueryError(`${operator} on ${named} takes ${expected}, and got ${show(value)}`, field.path);
    switch (kind) {
      case 'string':
      case 'id':
        if (typeof value !== 'string') throw wrong(kind === 'id' ? "a resource's id" : 'a string');
        return this.push(value);
      case 'enum': {
        const values = (field.info as { values: string[] }).values;
        if (typeof value !== 'string' || !values.includes(value)) throw wrong(`one of ${values.map((v) => JSON.stringify(v)).join(', ')}`);
        return this.push(value);
      }
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw wrong('a finite number');
        return this.push(value);
      case 'boolean':
        if (typeof value !== 'boolean') throw wrong('true or false');
        return this.push(value ? 1 : 0);
      case 'date':
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw wrong('a valid Date');
        return this.push(value.toISOString());
    }
  }

  push(value: SqlParam): string {
    this.params.push(value);
    return '?';
  }

  done(sql: string): CompiledWhere {
    if (this.params.length > MAX_BOUND_PARAMS) {
      throw new QueryError(
        `This filter binds ${this.params.length} values, and one query may bind ${MAX_BOUND_PARAMS}. Shorten its $in lists`);
    }
    return { sql, params: this.params };
  }
}

/**
 * Compile `filter` for resources of `typeName`. Pure: the same inputs give the same SQL text,
 * which is what an index compiled from the same ontology matches.
 *
 * The clause reads the `value` column alone, so a caller adds what selects the rows: a type's
 * current ones through {@link compileQuery}, or one snapshot by its `resourceId` and `validFrom`, to
 * ask whether a write just entered or left a query's results.
 *
 * @throws QueryError for anything it refuses, before it produces SQL.
 */
export function compileWhere(fields: FieldsMap, typeName: string, filter: Filter): CompiledWhere {
  const compilation = new Compilation(fields, typeName);
  currentRowsSql(fields, typeName);
  if (isPlainObject(filter) && Object.keys(filter).length === 0) return compilation.done('');
  return compilation.done(compilation.filter(filter, 'the filter'));
}

/** Whether `condition` on a field is one an index on that field can look up. */
function looksUp(condition: unknown): boolean {
  if (condition === null) return false;
  if (!isPlainObject(condition)) return true;
  return Object.entries(condition).some(([operator, operand]) => {
    if (operator === '$eq' || operator in ORDERING) return true;
    if (operator === '$in') return Array.isArray(operand) && operand.length > 0;
    if (operator === '$startsWith') {
      // An empty prefix has no last character, so its code is NaN and this is false.
      return typeof operand === 'string' && operand.charCodeAt(operand.length - 1) < RANGE_PREFIX_LIMIT;
    }
    return false;
  });
}

/** The fields `filter` gives an index something to look up on: its top level, and through `$and`. */
function lookedUpFields(filter: Filter, into = new Set<string>()): Set<string> {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(condition)) {
      for (const each of condition) if (isPlainObject(each)) lookedUpFields(each, into);
    } else if (!key.startsWith('$') && looksUp(condition)) {
      into.add(key);
    }
  }
  return into;
}

/**
 * The whole WHERE for a type's current resources that match `filter`: the type's current rows, in
 * the exact text an index from {@link compileIndex} carries, then the filter's clause.
 *
 * `indexes` is every index the host has created. A filter none of them can look anything up for is
 * refused, since it would read every current resource of the type; the file's header says what
 * counts. `{}` is allowed, as the request for all of them.
 *
 * @throws QueryError for a filter {@link compileWhere} refuses, and for one no index serves.
 */
export function compileQuery(
  fields: FieldsMap, typeName: string, filter: Filter, indexes: readonly IndexSpec[],
): { where: string; params: SqlParam[] } {
  const { sql, params } = compileWhere(fields, typeName, filter);
  const rows = currentRowsSql(fields, typeName);
  if (!sql) return { where: rows, params };
  const leading = [...new Set(indexes.filter((index) => index.type === typeName && index.fields.length > 0).map((index) => index.fields[0]!))];
  const lookedUp = lookedUpFields(filter);
  if (!leading.some((field) => lookedUp.has(field))) {
    const have = leading.length > 0
      ? `${typeName}'s indexes start with ${leading.map((field) => `"${field}"`).join(', ')}`
      : `${typeName} has no index`;
    throw new QueryError(
      `This filter would read every current ${typeName}. Give it a condition an index can look up, which is equality, $in, ` +
      `a range or $startsWith on the first field of an index, at the filter's top level or inside a top-level $and. ${have}`);
  }
  return { where: `${rows} AND ${sql}`, params };
}
