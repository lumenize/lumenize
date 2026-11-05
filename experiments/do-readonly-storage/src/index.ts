/**
 * Does touching a SQLite-backed Durable Object leave stored data Cloudflare reports, when the touch
 * only reads, or writes nothing at all? Each arm is a class of its own, so its objects list apart.
 *
 * - `NothingDO`: constructed and called; no storage call at all.
 * - `SchemaReadDO`: one `sqlite_master` read, which Mesh's base constructor, `hasAlarmRow()` and
 *   the Profile's `#written()` each make on a touch of an id nobody wrote.
 * - `KvGetDO`: one `kv.get` of a key that is not there, as an identity-stamp read is.
 * - `WriteThenDeleteAllDO`: one write, then `deleteAll()`.
 * - `WriteDO`: one write, kept. The positive control: if it lists without stored data, the
 *   listing cannot see what this experiment asks about.
 */
import { DurableObject } from 'cloudflare:workers';

export class NothingDO extends DurableObject {
  touch(): string { return 'nothing'; }
}

export class SchemaReadDO extends DurableObject {
  touch(): string {
    const rows = this.ctx.storage.sql.exec(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ProfileFields'`).toArray();
    return `schema-read: ${rows.length} rows`;
  }
}

export class KvGetDO extends DurableObject {
  touch(): string {
    return `kv-get: ${String(this.ctx.storage.kv.get('__lmz_do_binding_name'))}`;
  }
}

export class WriteThenDeleteAllDO extends DurableObject {
  async touch(): Promise<string> {
    this.ctx.storage.kv.put('k', 'v');
    await this.ctx.storage.deleteAll();
    return `write-then-delete-all: ${String(this.ctx.storage.kv.get('k'))}`;
  }
}

export class WriteDO extends DurableObject {
  touch(): string {
    this.ctx.storage.kv.put('k', 'v');
    return 'write';
  }
}

const ARMS = ['NOTHING', 'SCHEMA_READ', 'KV_GET', 'WRITE_DELETE_ALL', 'WRITE'] as const;
type Arm = typeof ARMS[number];
type TouchStub = { touch(): Promise<string> };

export default {
  /** `GET /touch?arm=SCHEMA_READ&name=…` touches one object and answers its id and what it did. */
  async fetch(request: Request, env: Record<Arm, DurableObjectNamespace>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/touch') return new Response('Not Found', { status: 404 });
    const arm = url.searchParams.get('arm') as Arm | null;
    const name = url.searchParams.get('name');
    if (!arm || !ARMS.includes(arm) || !name) return new Response('arm and name required', { status: 400 });
    const ns = env[arm];
    const stub = ns.getByName(name) as unknown as TouchStub;
    const did = await stub.touch();
    return Response.json({ arm, name, id: ns.idFromName(name).toString(), did });
  },
};
