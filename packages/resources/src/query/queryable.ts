/**
 * Find the values in a resource that a query would read wrongly, from its stored form.
 *
 * A query compares what `json_extract` finds in the stored text. A few values a type allows are
 * stored in a shape that comparison cannot read, so a resource holding one is refused when it is
 * written, as an implied constraint of the ontology:
 *
 * - **`Infinity`, `-Infinity`, `NaN` and `-0` in a number field.** Each is stored wrapped, and no
 *   comparison would find it.
 * - **An invalid `Date` in a date field.**
 * - **The same object held at two places.** The second is stored as a reference to the first, so a
 *   path into it finds nothing. Store a copy.
 *
 * It reads the stored text, not the live value, so it judges exactly what a query will see. A host
 * runs it beside the validator, on the text it is about to write.
 */
import type { FieldInfo, FieldsMap } from './fields';
import { fieldsOfType } from './fields';
import { QueryError } from './errors';

export interface QueryableIssue {
  /** The dotted path of the field, `address.city`. */
  path: string;
  message: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function walk(level: Record<string, FieldInfo>, stored: Record<string, unknown>, prefix: string, typeName: string, issues: QueryableIssue[]): void {
  for (const [name, info] of Object.entries(level)) {
    if (!Object.hasOwn(stored, name)) continue;
    const node = isObject(stored[name]) ? stored[name] as Record<string, unknown> : undefined;
    if (!node) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const wrapper = typeof node.$type === 'string' ? node.$type : undefined;
    if (info.kind === 'number' && wrapper === 'number-special') {
      issues.push({ path, message: `${typeName}.${path} is ${String(node.value)}, which a query cannot compare. Store a finite number, or leave the field out` });
    } else if (info.kind === 'date' && wrapper === 'date' && (typeof node.iso !== 'string' || Number.isNaN(Date.parse(node.iso)))) {
      issues.push({ path, message: `${typeName}.${path} is an invalid Date, which a query cannot compare` });
    } else if (info.kind === 'object') {
      if (typeof node.$ref === 'string') {
        issues.push({ path, message: `${typeName}.${path} is the same object as the one at ${node.$ref.replace(/^#\//, '').replaceAll('/', '.') || 'the root'}, and a query cannot reach into the second. Store a copy` });
      } else if (wrapper === undefined) {
        walk(info.fields, node, path, typeName, issues);
      }
    }
  }
}

/**
 * Every value in `storedValue` a query would read wrongly; empty when there is none.
 * `storedValue` is the structured-clone text of one resource of `typeName`.
 */
export function findUnqueryable(fields: FieldsMap, typeName: string, storedValue: string): QueryableIssue[] {
  const level = fieldsOfType(fields, typeName);
  const stored: unknown = JSON.parse(storedValue);
  const issues: QueryableIssue[] = [];
  if (isObject(stored)) walk(level, stored, '', typeName, issues);
  return issues;
}

/** {@link findUnqueryable}, thrown: one `QueryError` naming every issue. */
export function assertQueryable(fields: FieldsMap, typeName: string, storedValue: string): void {
  const issues = findUnqueryable(fields, typeName, storedValue);
  if (issues.length > 0) throw new QueryError(issues.map((issue) => issue.message).join('; '), issues[0]!.path);
}
