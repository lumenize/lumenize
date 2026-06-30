/**
 * REGISTRY_MIGRATIONS — the first prod DO schema migration (add improveProductConsent).
 *
 * The registry migrates eagerly in its constructor, so a registry stub's storage is never
 * pre-migration. The load-bearing "prod path" (existing column-less DB) is therefore exercised at
 * the runner level against a virgin BareStorageDO ctx.storage; the fresh path is verified on a real
 * NebulaAuthRegistry (its constructor wired the runner).
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import { REGISTRY_MIGRATIONS } from '../src/schemas';
import { PLATFORM_INSTANCE_NAME } from '../src/types';

const MARKER_KEY = '__sql_migrations_lastID';

/** Run `fn` with a virgin `ctx.storage` (a fresh BareStorageDO that runs no migrations of its own). */
async function inVirginStorage<T>(fn: (storage: any) => T): Promise<T> {
  const stub: any = env.BARE_STORAGE_DO.get(env.BARE_STORAGE_DO.newUniqueId());
  let out: T;
  // Cast: runInDurableObject's generic over the DO type instantiates excessively deep (TS2589).
  await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => { out = fn(ctx.storage); });
  return out!;
}

/** Seed the OLD (pre-consent) column-less Instances schema. */
function seedOldSchema(s: any): void {
  s.sql.exec('CREATE TABLE Instances (instanceName TEXT PRIMARY KEY, createdAt INTEGER NOT NULL) WITHOUT ROWID');
}

describe('REGISTRY_MIGRATIONS', () => {
  // B1 — the load-bearing prod path: existing column-less DB, no marker, then migrate.
  it('prod path: backfills only existing user Universes; sub-instances + platform stay NULL', async () => {
    const r = await inVirginStorage((s) => {
      seedOldSchema(s);
      const now = Date.now();
      for (const name of ['acme', 'acme.crm', 'acme.crm.tenant-a', PLATFORM_INSTANCE_NAME]) {
        s.sql.exec('INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)', name, now);
      }
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      const rows = s.sql.exec('SELECT instanceName, improveProductConsent AS c FROM Instances').toArray();
      return { byName: Object.fromEntries(rows.map((x: any) => [x.instanceName, x.c])), marker: s.kv.get(MARKER_KEY) };
    });
    expect(r.byName['acme']).toBe(1);                    // user Universe → consented (assume-true)
    expect(r.byName['acme.crm']).toBeNull();             // galaxy (u.g) → NULL (inherit)
    expect(r.byName['acme.crm.tenant-a']).toBeNull();    // star (u.g.s) → NULL
    expect(r.byName[PLATFORM_INSTANCE_NAME]).toBeNull(); // reserved platform pseudo-Universe → NULL
    expect(r.marker).toBe(5);
  });

  // Re-run is a no-op; and the backfill must NOT reset a since-declined (0) row across a cold construct (M8).
  it('re-run does not re-touch the backfill — a declined (0) Universe stays 0 across a cold construct', async () => {
    const declined = await inVirginStorage((s) => {
      seedOldSchema(s);
      s.sql.exec('INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)', 'acme', Date.now());
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      // Simulate a later opt-out, then a DO eviction + cold construct: a FRESH runner re-reads the
      // PERSISTED marker (not the in-memory cache) and must skip the already-applied backfill.
      s.sql.exec("UPDATE Instances SET improveProductConsent = 0 WHERE instanceName = 'acme'");
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      return s.sql.exec("SELECT improveProductConsent AS c FROM Instances WHERE instanceName = 'acme'").toArray()[0].c;
    });
    expect(declined).toBe(0); // NOT reset to 1
  });

  // Fresh path — a real NebulaAuthRegistry: its constructor ran the migration, so the column exists.
  it('fresh path: a new NebulaAuthRegistry has the migrated schema (constructor wired the runner)', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-fresh-${crypto.randomUUID()}`);
    const r = await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => {
      // The column exists (constructor migrated); write + read it back through the new column.
      ctx.storage.sql.exec('INSERT INTO Instances (instanceName, createdAt, improveProductConsent) VALUES (?, ?, 1)', 'acme', Date.now());
      return {
        c: ctx.storage.sql.exec("SELECT improveProductConsent AS c FROM Instances WHERE instanceName = 'acme'").toArray()[0].c,
        marker: ctx.storage.kv.get(MARKER_KEY),
      };
    });
    expect(r.c).toBe(1);
    expect(r.marker).toBe(5);
  });
});
