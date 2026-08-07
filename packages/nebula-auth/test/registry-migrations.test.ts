/**
 * REGISTRY_MIGRATIONS — the collapsed registry baseline: six tables, WITHOUT ROWID, ISO timestamps.
 *
 * ⚠️ The ids start ABOVE the replaced list's highest id rather than at 1, because the runner selects on
 * `id > marker` — a 1-based baseline would match nothing on any storage that had applied the old list
 * and return {0,0}, which is indistinguishable from healthy. `LAST_ID` below is DERIVED from the list,
 * so it needs no maintenance when the list grows.
 *
 * The registry migrates eagerly in its constructor, so a registry stub's storage is never
 * pre-migration; the raw migration run is exercised at the runner level against a virgin
 * BareStorageDO ctx.storage, and the fresh path is verified on a real NebulaAuthRegistry.
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import { REGISTRY_MIGRATIONS } from '../src/schemas';

const MARKER_KEY = '__sql_migrations_lastID';
const LAST_ID = REGISTRY_MIGRATIONS[REGISTRY_MIGRATIONS.length - 1]!.idMonotonicInc;

/** Run `fn` with a virgin `ctx.storage` (a fresh BareStorageDO that runs no migrations of its own). */
async function inVirginStorage<T>(fn: (storage: any) => T): Promise<T> {
  const stub: any = env.BARE_STORAGE_DO.get(env.BARE_STORAGE_DO.newUniqueId());
  let out: T;
  // Cast: runInDurableObject's generic over the DO type instantiates excessively deep (TS2589).
  await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => { out = fn(ctx.storage); });
  return out!;
}

const EXPECTED_TABLES = ['Scopes', 'Emails', 'Memberships', 'RefreshTokenIndex', 'MagicLinks', 'InviteTokens'];

describe('REGISTRY_MIGRATIONS (greenfield)', () => {
  it('creates all registry tables + the sub index on a virgin DB and sets the marker', async () => {
    const r = await inVirginStorage((s) => {
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      const tables = s.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((x: any) => x.name);
      const indexes = s.sql.exec("SELECT name FROM sqlite_master WHERE type='index'").toArray().map((x: any) => x.name);
      const scopeCols = s.sql.exec("SELECT name FROM pragma_table_info('Scopes')").toArray().map((x: any) => x.name);
      return { tables, indexes, scopeCols, marker: s.kv.get(MARKER_KEY) };
    });
    for (const t of EXPECTED_TABLES) expect(r.tables).toContain(t);
    expect(r.indexes).toContain('idx_RefreshTokenIndex_sub');
    // INVERTED, not deleted: the profileId index moved from the join table to the address table when
    // profileId became a property of the ADDRESS. Asserting BOTH halves is what proves it moved rather
    // than merely that something exists — the old name surviving would mean the re-key was partial.
    expect(r.indexes).toContain('idx_Emails_profileId');
    expect(r.indexes).not.toContain('idx_Identities_profileId');
    // The consent column is gone from the collapsed baseline entirely — assert the end state so a
    // re-added column reds here rather than resurrecting dead state.
    expect(r.scopeCols).toEqual(['universeGalaxyStarId']);
    expect(r.marker).toBe(LAST_ID);
  });

  it('re-run is a no-op (marker gates it) — a seeded row survives a second construct', async () => {
    const survived = await inVirginStorage((s) => {
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      s.sql.exec("INSERT INTO Scopes (universeGalaxyStarId) VALUES ('acme')");
      // A fresh runner re-reads the persisted marker and skips the already-applied migrations.
      new SQLSchemaMigrations({ doStorage: s, migrations: REGISTRY_MIGRATIONS }).runAll();
      return s.sql.exec("SELECT universeGalaxyStarId AS id FROM Scopes").toArray();
    });
    expect(survived).toEqual([{ id: 'acme' }]); // not dropped/recreated by the re-run
  });

  /**
   * ⚠️ **Driven through the DO's OWN alarm — the sweep is never re-executed by hand here.** The
   * previous version of this test re-ran the two DELETE statements itself inside `runInDurableObject`
   * and then asserted on its own writes, so it was green regardless of what the registry did; its
   * comment ("the exact sweep the constructor runs") then invited the same shape for the alarm. A test
   * that reimplements the code under test measures the reimplementation.
   *
   * ⚠️ **What makes all three arms alarm-driven is the SEEDING ORDER, not the table choice.** The
   * constructor calls the same `#sweepAndRearm`, so it sweeps all three tables too — no arm
   * distinguishes alarm from constructor by itself. The rows are therefore inserted into an ALREADY
   * CONSTRUCTED DO with no intervening wake, so only the alarm can have removed them.
   */
  it('the alarm sweeps all three token tables — expired gone, fresh kept', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-sweep-${crypto.randomUUID()}`);
    const past = '2020-01-01T00:00:00.000Z';
    const future = '9999-01-01T00:00:00.000Z';
    await (runInDurableObject as any)(stub, (_i: any, ctx: any) => {
      ctx.storage.sql.exec("INSERT INTO MagicLinks (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES ('m-old','a@x','acme',?)", past);
      ctx.storage.sql.exec("INSERT INTO MagicLinks (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES ('m-new','a@x','acme',?)", future);
      ctx.storage.sql.exec("INSERT INTO InviteTokens (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES ('i-old','a@x','acme',?)", past);
      ctx.storage.sql.exec("INSERT INTO InviteTokens (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES ('i-new','a@x','acme',?)", future);
      ctx.storage.sql.exec("INSERT INTO RefreshTokenIndex (tokenHash, sub, expiresAt) VALUES ('r-old','s1',?)", past);
      ctx.storage.sql.exec("INSERT INTO RefreshTokenIndex (tokenHash, sub, expiresAt) VALUES ('r-new','s1',?)", future);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);   // an alarm was scheduled AND it ran

    const rows = await (runInDurableObject as any)(stub, (_i: any, ctx: any) => ({
      magic: ctx.storage.sql.exec('SELECT tokenHash FROM MagicLinks ORDER BY tokenHash').toArray().map((r: any) => r.tokenHash),
      invite: ctx.storage.sql.exec('SELECT tokenHash FROM InviteTokens ORDER BY tokenHash').toArray().map((r: any) => r.tokenHash),
      refresh: ctx.storage.sql.exec('SELECT tokenHash FROM RefreshTokenIndex ORDER BY tokenHash').toArray().map((r: any) => r.tokenHash),
    }));
    // Per-table, so a broken arm names itself: delete any one DELETE and exactly its row survives.
    expect(rows.magic).toEqual(['m-new']);
    expect(rows.invite).toEqual(['i-new']);
    expect(rows.refresh).toEqual(['r-new']);
  });

  /**
   * The alarm must be ARMED, not merely re-armed. A build that arms only at the tail of `alarm()` ships
   * a sweep that never runs unattended — and the sweep-contents test above cannot catch it, because the
   * constructor satisfies two of its three arms on any wake.
   */
  it('a freshly-constructed registry has an alarm scheduled, and the tick re-arms it', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-arm-${crypto.randomUUID()}`);
    const armed = async () => (runInDurableObject as any)(stub, (_i: any, ctx: any) => ctx.storage.getAlarm());
    expect(await armed()).not.toBeNull();                   // reds if the constructor does not arm

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await armed()).not.toBeNull();                   // reds if the tick does not re-arm
  });

  /**
   * 🔒 The criterion the corrected design reds against. An absence-keyed predicate — "no live activation
   * path" — would have deleted a user-developer's scope within the hour, with its slug freed.
   */
  it('the sweep reaps NOTHING else — a member-less scope and an un-taken-up claim both survive', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-keep-${crypto.randomUUID()}`);
    // ⚠️ TWO SEPARATE scope ids, and that separation is the whole test. An earlier version put the
    // claimer's membership on the same id as the supposedly member-less scope, so the fixture
    // contained no member-less scope at all — and the mutant this is aimed at
    // (`DELETE FROM Scopes WHERE universeGalaxyStarId NOT IN (SELECT … FROM Memberships)`) stayed
    // green while it would have wiped every admin-created scope within the hour.
    await (runInDurableObject as any)(stub, (_i: any, ctx: any) => {
      // (a) An admin-created scope: a `Scopes` row and NOTHING else, ever. `createGalaxy`/`createStar`
      // write exactly this and never mint a membership, because the creator's own wildcard pattern
      // already reaches it — so "no members" is the normal steady state, not an abandoned one.
      ctx.storage.sql.exec("INSERT INTO Scopes (universeGalaxyStarId) VALUES ('memberless.app')");
      // (b) An un-taken-up claimer, on a DIFFERENT scope: the row `#resumeClaimIfOwner` is designed to
      // read AFTER its link expires, matching its `scopeAdmin = 1 AND acceptedAt IS NULL` predicate.
      ctx.storage.sql.exec("INSERT INTO Scopes (universeGalaxyStarId) VALUES ('claimed.app')");
      ctx.storage.sql.exec("INSERT INTO Emails (emailId, email, profileId, emailVerified, createdAt) VALUES ('e-keep','k@x','p-keep',0,?)", '2020-01-01T00:00:00.000Z');
      ctx.storage.sql.exec("INSERT INTO Memberships (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt) VALUES ('s-keep','e-keep','claimed.app',1,NULL,?)", '2020-01-01T00:00:00.000Z');
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const survived = await (runInDurableObject as any)(stub, (_i: any, ctx: any) => ({
      memberless: ctx.storage.sql.exec("SELECT universeGalaxyStarId AS s FROM Scopes WHERE universeGalaxyStarId = 'memberless.app'").toArray().length,
      claimedScope: ctx.storage.sql.exec("SELECT universeGalaxyStarId AS s FROM Scopes WHERE universeGalaxyStarId = 'claimed.app'").toArray().length,
      emails: ctx.storage.sql.exec("SELECT emailId FROM Emails WHERE emailId = 'e-keep'").toArray().length,
      memberships: ctx.storage.sql.exec("SELECT sub FROM Memberships WHERE sub = 's-keep'").toArray().length,
    }));
    expect(survived).toEqual({ memberless: 1, claimedScope: 1, emails: 1, memberships: 1 });

    // And the scope is still ENUMERABLE — one of the four readers that need the row, and the one a
    // user-developer would notice: a Galaxy vanishing from their tree.
    const tree = (await stub.myScopeTree({ authScopePattern: '*', scopeAdmin: true }))
      .map((s: any) => s.instanceName);
    expect(tree).toContain('memberless.app');
  });

  it('fresh path: a new NebulaAuthRegistry has the migrated schema (constructor wired the runner)', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-fresh-${crypto.randomUUID()}`);
    const r = await (runInDurableObject as any)(stub, (_instance: any, ctx: any) => {
      ctx.storage.sql.exec("INSERT INTO Emails (emailId, email, profileId, emailVerified, createdAt) VALUES ('e1','a@x.com','p1',1,'2026-01-01T00:00:00.000Z')");
      ctx.storage.sql.exec("INSERT INTO Memberships (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt) VALUES ('s1','e1','acme',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
      return {
        row: ctx.storage.sql.exec("SELECT sub, scopeAdmin AS a FROM Memberships WHERE sub = 's1'").toArray()[0],
        marker: ctx.storage.kv.get(MARKER_KEY),
      };
    });
    expect(r.row).toEqual({ sub: 's1', a: 1 });
    expect(r.marker).toBe(LAST_ID);
  });
});
