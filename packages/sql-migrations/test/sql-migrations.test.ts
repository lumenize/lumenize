import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SQLSchemaMigrations, type SQLSchemaMigration } from '../src/index';

const MARKER_KEY = '__sql_migrations_lastID';

/** Run `fn` inside a fresh SQLite-backed DO, handing it the real `ctx.storage`. */
async function inStorage<T>(fn: (storage: any) => T): Promise<T> {
  const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
  let out: T;
  await runInDurableObject(stub, (_instance: any, state: any) => {
    out = fn(state.storage);
  });
  return out!;
}

const create = (id: number, table = `t${id}`): SQLSchemaMigration => ({
  idMonotonicInc: id,
  description: `create ${table}`,
  sql: `CREATE TABLE ${table} (x INTEGER)`,
});

describe('SQLSchemaMigrations', () => {
  // happy path + return contract (M3) — also reddens if cursor.toArray() is dropped (n1)
  it('applies migrations in id order and reports rowsWritten > 0 for an INSERT', async () => {
    const r = await inStorage((s) => {
      const res = new SQLSchemaMigrations({
        doStorage: s,
        migrations: [
          { idMonotonicInc: 1, description: 'create', sql: 'CREATE TABLE foo (x INTEGER)' },
          { idMonotonicInc: 2, description: 'insert', sql: 'INSERT INTO foo (x) VALUES (42)' },
        ],
      }).runAll();
      const rows = s.sql.exec('SELECT x FROM foo').toArray();
      return { res, rows };
    });
    expect(r.rows).toEqual([{ x: 42 }]);
    expect(r.res.rowsWritten).toBeGreaterThan(0);
  });

  // params binding (the #3 addition) — bound, never interpreted
  it('binds params and does not interpret SQL metacharacters', async () => {
    const evil = "'); DROP TABLE foo; --";
    const rows = await inStorage((s) => {
      new SQLSchemaMigrations({
        doStorage: s,
        migrations: [
          { idMonotonicInc: 1, description: 'create', sql: 'CREATE TABLE foo (name TEXT)' },
          { idMonotonicInc: 2, description: 'insert bound', sql: 'INSERT INTO foo (name) VALUES (?)', params: [evil] },
        ],
      }).runAll();
      return s.sql.exec('SELECT name FROM foo').toArray();
    });
    expect(rows).toEqual([{ name: evil }]); // landed verbatim; the table was not dropped
  });

  // edge: empty list → {0,0}, no marker write (m2a)
  it('empty migrations list is a no-op returning {0,0} with no marker written', async () => {
    const r = await inStorage((s) => {
      const res = new SQLSchemaMigrations({ doStorage: s, migrations: [] }).runAll();
      return { res, marker: s.kv.get(MARKER_KEY) };
    });
    expect(r.res).toEqual({ rowsRead: 0, rowsWritten: 0 });
    expect(r.marker).toBeUndefined();
  });

  // edge: partial-prefix — the literal prod path the consumer depends on (m2c)
  it('partial-prefix: with marker at 1, supplying [id1, id2] runs only id2', async () => {
    const r = await inStorage((s) => {
      // Apply id1 alone first.
      new SQLSchemaMigrations({ doStorage: s, migrations: [create(1, 'foo')] }).runAll();
      // id1 is a bare CREATE TABLE (no IF NOT EXISTS): re-running it would throw "table exists",
      // so the fact id2 succeeds proves id1 was skipped.
      const res = new SQLSchemaMigrations({
        doStorage: s,
        migrations: [create(1, 'foo'), { idMonotonicInc: 2, description: 'insert', sql: 'INSERT INTO foo (x) VALUES (7)' }],
      }).runAll();
      return { res, rows: s.sql.exec('SELECT x FROM foo').toArray(), marker: s.kv.get(MARKER_KEY) };
    });
    expect(r.rows).toEqual([{ x: 7 }]);
    expect(r.marker).toBe(2);
  });

  // run-twice-is-noop (m2b + n2) — second run writes nothing; marker unchanged
  it('re-running once current is a no-op (same instance and cold instance); marker unchanged', async () => {
    const r = await inStorage((s) => {
      const migs = [create(1, 'foo')];
      const m = new SQLSchemaMigrations({ doStorage: s, migrations: migs });
      m.runAll();
      const sameInstance = m.runAll(); // in-memory short-circuit
      const coldInstance = new SQLSchemaMigrations({ doStorage: s, migrations: migs }).runAll(); // reads marker, returns
      return { sameInstance, coldInstance, marker: s.kv.get(MARKER_KEY) };
    });
    expect(r.sameInstance).toEqual({ rowsRead: 0, rowsWritten: 0 });
    expect(r.coldInstance).toEqual({ rowsRead: 0, rowsWritten: 0 });
    expect(r.marker).toBe(1);
  });

  // composition pattern (the markerKey knob): two independently-migrated components
  // in ONE DO each track their own progress under a distinct marker — no collision.
  it('distinct markerKeys let two runners in one DO advance independently', async () => {
    const r = await inStorage((s) => {
      // Component A owns table `a`; component B owns table `b`. Each has its OWN list
      // + marker. A is at id 2, B only at id 1 — distinct counters prove no sharing.
      new SQLSchemaMigrations({
        doStorage: s, markerKey: '__mig_A',
        migrations: [create(1, 'a'), { idMonotonicInc: 2, description: 'a row', sql: 'INSERT INTO a (x) VALUES (1)' }],
      }).runAll();
      new SQLSchemaMigrations({
        doStorage: s, markerKey: '__mig_B',
        migrations: [create(1, 'b')],
      }).runAll();
      return {
        markerA: s.kv.get('__mig_A'),
        markerB: s.kv.get('__mig_B'),
        sharedMarker: s.kv.get(MARKER_KEY),
        aRows: s.sql.exec('SELECT x FROM a').toArray(),
        bExists: s.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='b'`).toArray().length,
      };
    });
    // Independent counters; the default key was never touched (both used their own).
    expect(r.markerA).toBe(2);
    expect(r.markerB).toBe(1);
    expect(r.sharedMarker).toBeUndefined();
    expect(r.aRows).toEqual([{ x: 1 }]);
    expect(r.bExists).toBe(1);
  });

  // Without the knob, a SHARED default marker collides: B sees A's marker (2) and
  // skips its own id-1 → table `b2` is never created (the bug the knob prevents).
  it('a shared default marker collides across components (why distinct keys are required)', async () => {
    const r = await inStorage((s) => {
      new SQLSchemaMigrations({
        doStorage: s, // default marker
        migrations: [create(1, 'a2'), { idMonotonicInc: 2, description: 'a row', sql: 'INSERT INTO a2 (x) VALUES (1)' }],
      }).runAll();
      // Component B (default marker) starts at id 1, but the shared marker is already 2.
      new SQLSchemaMigrations({
        doStorage: s,
        migrations: [create(1, 'b2')],
      }).runAll();
      return s.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='b2'`).toArray().length;
    });
    expect(r).toBe(0); // b2 NOT created — the collision distinct markerKeys avoid
  });

  it('throws at construction on an empty markerKey', async () => {
    await inStorage((s) => {
      expect(() => new SQLSchemaMigrations({
        doStorage: s, markerKey: '', migrations: [create(1)],
      })).toThrow(/markerKey/i);
    });
  });

  // construction validation — negative, independent assertions (M2/m5)
  it('throws at construction on a negative migration id', async () => {
    await inStorage((s) => {
      expect(() => new SQLSchemaMigrations({
        doStorage: s,
        migrations: [{ idMonotonicInc: -1, description: 'bad', sql: 'SELECT 1' }],
      })).toThrow(/negative/i);
    });
  });

  it('throws at construction on a duplicate migration id', async () => {
    await inStorage((s) => {
      expect(() => new SQLSchemaMigrations({
        doStorage: s,
        migrations: [
          { idMonotonicInc: 1, description: 'a', sql: 'SELECT 1' },
          { idMonotonicInc: 1, description: 'b', sql: 'SELECT 2' },
        ],
      })).toThrow(/duplicate/i);
    });
  });

  // immutability of an applied migration — marker-gated, detected at runAll, not construction
  it('does not re-run an applied migration even if its sql is later edited', async () => {
    const rows = await inStorage((s) => {
      const base = [
        { idMonotonicInc: 1, description: 'create', sql: 'CREATE TABLE foo (x INTEGER)' },
        { idMonotonicInc: 2, description: 'insert', sql: 'INSERT INTO foo (x) VALUES (1)' },
      ];
      new SQLSchemaMigrations({ doStorage: s, migrations: base }).runAll();
      const edited = [
        base[0],
        { idMonotonicInc: 2, description: 'insert', sql: 'INSERT INTO foo (x) VALUES (999)' },
      ];
      new SQLSchemaMigrations({ doStorage: s, migrations: edited }).runAll();
      return s.sql.exec('SELECT x FROM foo').toArray();
    });
    expect(rows).toEqual([{ x: 1 }]); // 999 never inserted
  });

  // atomic rollback (proves D3) — a later step's throw rolls back earlier writes + leaves the marker un-advanced
  it('rolls back an earlier write and does not advance the marker when a later step throws', async () => {
    const r = await inStorage((s) => {
      s.sql.exec('CREATE TABLE acc (x INTEGER)'); // pre-existing table, no marker yet
      let threw = false;
      try {
        new SQLSchemaMigrations({
          doStorage: s,
          migrations: [
            { idMonotonicInc: 1, description: 'lands a row', sql: 'INSERT INTO acc (x) VALUES (1)' },
            { idMonotonicInc: 2, description: 'throws at exec', sql: 'INSERT INTO acc (nonexistent) VALUES (2)' },
          ],
        }).runAll();
      } catch {
        threw = true;
      }
      return { threw, rows: s.sql.exec('SELECT x FROM acc').toArray(), marker: s.kv.get(MARKER_KEY) };
    });
    expect(r.threw).toBe(true);
    expect(r.rows).toEqual([]); // id-1's insert rolled back
    expect(r.marker).toBeUndefined(); // marker never advanced
  });
});
