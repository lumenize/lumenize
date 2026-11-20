/**
 * A query, an index or a value the query engine refuses, with `path` naming the field or the
 * operator it refused. Thrown by the compilers, which refuse before they produce any SQL.
 *
 * It crosses a mesh call as a plain `Error`, so a caller tells it apart by `err.name === 'QueryError'`,
 * never by `instanceof` (`mesh.md` § *Errors across mesh calls*).
 */
export class QueryError extends Error {
  override name = 'QueryError';
  constructor(message: string, public readonly path?: string) {
    super(message);
  }
}
