/**
 * REGISTRY_MIGRATIONS — the greenfield registry schema (tasks/nebula-auth-surrogate-sub.md reset the
 * baseline: 6 tables, WITHOUT ROWID, ISO timestamps; no `Instances`/`Emails` backfill).
 *
 * The registry migrates eagerly in its constructor, so a registry stub's storage is never
 * pre-migration; the raw migration run is exercised at the runner level against a virgin
 * BareStorageDO ctx.storage, and the fresh path is verified on a real NebulaAuthRegistry.
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import { REGISTRY_MIGRATIONS } from '../src/schemas';

const MARKER_KEY = '__sql_migrations_lastID';
const LAST_ID = REGISTRY_MIGRATIONS[REGISTRY_MIGRATIONS.length - 1]!.idMonotonicInc; // 6

/** Run `fn` with a virgin `ctx.storage` (a fresh BareStorageDO that runs no migrations of its own). */
async function inVirginStorage<T>(fn: (storage: any) => T): Promise<T> {
  const stub: any = env.BARE_STORAGE_DO.get(env.BARE_STORAGE_DO.newUniqueId());
  let out: T;
  // Cast: runInDurableObject's generic over the DO type instantiates excessively deep (TS2589).
  await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => { out = fn(ctx.storage); });
  return out!;
}

const EXPECTED_TABLES = ['Scopes', 'Identities', 'RefreshTokenIndex', 'MagicLinks', 'InviteTokens'];

describe('REGISTRY_MIGRATIONS (greenfield)', () => {
  it('creates all registry tables + the sub index on a virgin DB and sets the marker', async () => {
    const r = await inVirginStorage((s) => {
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      const tables = s.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((x: any) => x.name);
      const indexes = s.sql.exec("SELECT name FROM sqlite_master WHERE type='index'").toArray().map((x: any) => x.name);
      return { tables, indexes, marker: s.kv.get(MARKER_KEY) };
    });
    for (const t of EXPECTED_TABLES) expect(r.tables).toContain(t);
    expect(r.indexes).toContain('idx_RefreshTokenIndex_sub');
    expect(r.marker).toBe(LAST_ID);
  });

  it('re-run is a no-op (marker gates it) — a seeded row survives a second construct', async () => {
    const survived = await inVirginStorage((s) => {
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      s.sql.exec("INSERT INTO Scopes (universeGalaxyStarId, improveProductConsent) VALUES ('acme', 1)");
      // A fresh runner re-reads the persisted marker and skips the already-applied migrations.
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      return s.sql.exec("SELECT improveProductConsent AS c FROM Scopes WHERE universeGalaxyStarId = 'acme'").toArray();
    });
    expect(survived).toEqual([{ c: 1 }]); // not dropped/recreated by the re-run
  });

  it('fresh path: a new NebulaAuthRegistry has the migrated schema (constructor wired the runner)', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-fresh-${crypto.randomUUID()}`);
    const r = await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => {
      ctx.storage.sql.exec("INSERT INTO Identities (sub, universeGalaxyStarId, email, isAdmin, emailVerified, createdAt) VALUES ('s1','acme','a@x.com',1,1,'2026-01-01T00:00:00.000Z')");
      return {
        row: ctx.storage.sql.exec("SELECT sub, isAdmin AS a FROM Identities WHERE sub = 's1'").toArray()[0],
        marker: ctx.storage.kv.get(MARKER_KEY),
      };
    });
    expect(r.row).toEqual({ sub: 's1', a: 1 });
    expect(r.marker).toBe(LAST_ID);
  });
});
