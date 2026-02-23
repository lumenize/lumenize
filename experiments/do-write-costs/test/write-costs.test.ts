/**
 * DO SQLite Write Cost Experiments
 *
 * Empirically measures how indexes, PRIMARY KEY definitions, UNIQUE constraints,
 * WITHOUT ROWID, UPDATEs, DELETEs, and batch INSERTs affect `rowsWritten` in
 * Cloudflare Durable Objects SQLite storage.
 *
 * Each test uses a unique DO instance (fresh SQLite database) to avoid interference.
 */
import { it, expect, describe } from "vitest";
import { env } from "cloudflare:test";

/** Helper: get a fresh DO stub with an empty database */
function freshDO(name: string) {
  const id = env.WRITE_COST_DO.idFromName(name);
  return env.WRITE_COST_DO.get(id);
}

// ─── Q1: Compound index write count ──────────────────────────────────────────

describe("Q1: Compound index write count", () => {
  it("INSERT with no indexes", async () => {
    const stub = freshDO("q1-no-index");
    await stub.execSql("CREATE TABLE t(a TEXT, b TEXT, c TEXT)");
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  No index: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT with single-column index", async () => {
    const stub = freshDO("q1-single-index");
    await stub.execSql("CREATE TABLE t(a TEXT, b TEXT, c TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  Single index: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT with compound index (a, b)", async () => {
    const stub = freshDO("q1-compound-index");
    await stub.execSql("CREATE TABLE t(a TEXT, b TEXT, c TEXT)");
    await stub.execSql("CREATE INDEX idx_ab ON t(a, b)");
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  Compound index (a,b): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT with two separate single-column indexes", async () => {
    const stub = freshDO("q1-two-indexes");
    await stub.execSql("CREATE TABLE t(a TEXT, b TEXT, c TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("CREATE INDEX idx_b ON t(b)");
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  Two separate indexes: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q2: Implicit rowid, INTEGER PRIMARY KEY alias, WITHOUT ROWID ────────────

describe("Q2: Implicit rowid, INTEGER PRIMARY KEY alias, WITHOUT ROWID", () => {
  it("TEXT PRIMARY KEY with implicit rowid (default)", async () => {
    const stub = freshDO("q2-text-pk");
    await stub.execSql("CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT)");
    const result = await stub.execSql("INSERT INTO t(a, b) VALUES (?, ?)", ["k1", "v1"]);
    console.log(`  TEXT PK (implicit rowid): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("TEXT PRIMARY KEY WITHOUT ROWID", async () => {
    const stub = freshDO("q2-text-pk-no-rowid");
    await stub.execSql("CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID");
    const result = await stub.execSql("INSERT INTO t(a, b) VALUES (?, ?)", ["k1", "v1"]);
    console.log(`  TEXT PK WITHOUT ROWID: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INTEGER PRIMARY KEY (rowid alias)", async () => {
    const stub = freshDO("q2-int-pk");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
    const result = await stub.execSql("INSERT INTO t(id, b) VALUES (?, ?)", [1, "v1"]);
    console.log(`  INTEGER PK (rowid alias): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("no explicit PK (rowid only)", async () => {
    const stub = freshDO("q2-no-pk");
    await stub.execSql("CREATE TABLE t(a TEXT, b TEXT)");
    const result = await stub.execSql("INSERT INTO t(a, b) VALUES (?, ?)", ["k1", "v1"]);
    console.log(`  No PK (implicit rowid): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q3: UNIQUE constraint cost ──────────────────────────────────────────────

describe("Q3: UNIQUE constraint cost", () => {
  it("UNIQUE constraint on column", async () => {
    const stub = freshDO("q3-unique");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    const result = await stub.execSql("INSERT INTO t(id, email) VALUES (?, ?)", [
      1, "a@b.com",
    ]);
    console.log(`  UNIQUE constraint: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("explicit index instead of UNIQUE", async () => {
    const stub = freshDO("q3-index");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)");
    await stub.execSql("CREATE INDEX idx_email ON t(email)");
    const result = await stub.execSql("INSERT INTO t(id, email) VALUES (?, ?)", [
      1, "a@b.com",
    ]);
    console.log(`  Explicit index: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("UNIQUE index (CREATE UNIQUE INDEX)", async () => {
    const stub = freshDO("q3-unique-index");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)");
    await stub.execSql("CREATE UNIQUE INDEX idx_email ON t(email)");
    const result = await stub.execSql("INSERT INTO t(id, email) VALUES (?, ?)", [
      1, "a@b.com",
    ]);
    console.log(`  UNIQUE INDEX: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q4: Compound PK leftmost prefix ────────────────────────────────────────

describe("Q4: Compound PK leftmost prefix", () => {
  it("compound PK (a, b) only", async () => {
    const stub = freshDO("q4-compound-pk");
    await stub.execSql(
      "CREATE TABLE t(a TEXT, b TEXT, c TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
    );
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  Compound PK only: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("compound PK (a, b) + redundant index on (a)", async () => {
    const stub = freshDO("q4-redundant-index");
    await stub.execSql(
      "CREATE TABLE t(a TEXT, b TEXT, c TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
    );
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    const result = await stub.execSql("INSERT INTO t(a, b, c) VALUES (?, ?, ?)", [
      "x", "y", "z",
    ]);
    console.log(`  Compound PK + redundant idx(a): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q5: UPDATE — indexed vs non-indexed columns ────────────────────────────

describe("Q5: UPDATE costs — indexed vs non-indexed columns", () => {
  it("UPDATE non-indexed column (table with 2 indexes)", async () => {
    const stub = freshDO("q5-update-non-indexed");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, indexed_col TEXT, non_indexed_col TEXT)",
    );
    await stub.execSql("CREATE INDEX idx_ic ON t(indexed_col)");
    await stub.execSql("INSERT INTO t(id, indexed_col, non_indexed_col) VALUES (?, ?, ?)", [
      1, "idx_val", "plain_val",
    ]);
    const result = await stub.execSql(
      "UPDATE t SET non_indexed_col = ? WHERE id = ?",
      ["new_val", 1],
    );
    console.log(`  UPDATE non-indexed col (1 index): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("UPDATE indexed column (table with 2 indexes)", async () => {
    const stub = freshDO("q5-update-indexed");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, indexed_col TEXT, non_indexed_col TEXT)",
    );
    await stub.execSql("CREATE INDEX idx_ic ON t(indexed_col)");
    await stub.execSql("INSERT INTO t(id, indexed_col, non_indexed_col) VALUES (?, ?, ?)", [
      1, "idx_val", "plain_val",
    ]);
    const result = await stub.execSql(
      "UPDATE t SET indexed_col = ? WHERE id = ?",
      ["new_idx_val", 1],
    );
    console.log(`  UPDATE indexed col (1 index): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("UPDATE indexed column (table with 3 extra indexes, only 1 affected)", async () => {
    const stub = freshDO("q5-update-1-of-3-indexed");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT)",
    );
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("CREATE INDEX idx_b ON t(b)");
    await stub.execSql("CREATE INDEX idx_c ON t(c)");
    await stub.execSql("INSERT INTO t(id, a, b, c) VALUES (?, ?, ?, ?)", [
      1, "a1", "b1", "c1",
    ]);
    const result = await stub.execSql("UPDATE t SET c = ? WHERE id = ?", ["c2", 1]);
    console.log(`  UPDATE 1-of-3 indexed cols: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("UPDATE truly non-indexed column (table with 3 extra indexes)", async () => {
    const stub = freshDO("q5-update-truly-non-indexed");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, plain TEXT)",
    );
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("CREATE INDEX idx_b ON t(b)");
    await stub.execSql("CREATE INDEX idx_c ON t(c)");
    await stub.execSql("INSERT INTO t(id, a, b, c, plain) VALUES (?, ?, ?, ?, ?)", [
      1, "a1", "b1", "c1", "plain1",
    ]);
    const result = await stub.execSql("UPDATE t SET plain = ? WHERE id = ?", ["plain2", 1]);
    console.log(`  UPDATE non-indexed col (3 indexes on other cols): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q6: DELETE costs with varying index counts ─────────────────────────────

describe("Q6: DELETE costs with multiple indexes", () => {
  it("DELETE from table with 0 extra indexes", async () => {
    const stub = freshDO("q6-delete-0idx");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [1, "val"]);
    const result = await stub.execSql("DELETE FROM t WHERE id = ?", [1]);
    console.log(`  DELETE (0 extra indexes): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("DELETE from table with 1 extra index", async () => {
    const stub = freshDO("q6-delete-1idx");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [1, "val"]);
    const result = await stub.execSql("DELETE FROM t WHERE id = ?", [1]);
    console.log(`  DELETE (1 extra index): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("DELETE from table with 2 extra indexes", async () => {
    const stub = freshDO("q6-delete-2idx");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("CREATE INDEX idx_b ON t(b)");
    await stub.execSql("INSERT INTO t(id, a, b) VALUES (?, ?, ?)", [1, "a1", "b1"]);
    const result = await stub.execSql("DELETE FROM t WHERE id = ?", [1]);
    console.log(`  DELETE (2 extra indexes): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("DELETE from table with 3 extra indexes", async () => {
    const stub = freshDO("q6-delete-3idx");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    await stub.execSql("CREATE INDEX idx_b ON t(b)");
    await stub.execSql("CREATE INDEX idx_c ON t(c)");
    await stub.execSql("INSERT INTO t(id, a, b, c) VALUES (?, ?, ?, ?)", [
      1, "a1", "b1", "c1",
    ]);
    const result = await stub.execSql("DELETE FROM t WHERE id = ?", [1]);
    console.log(`  DELETE (3 extra indexes): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q7: Batch INSERT ────────────────────────────────────────────────────────

describe("Q7: Batch INSERT", () => {
  it("3 separate INSERTs (baseline)", async () => {
    const stub = freshDO("q7-separate");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    const r1 = await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [1, "a1"]);
    const r2 = await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [2, "a2"]);
    const r3 = await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [3, "a3"]);
    const total = r1.rowsWritten + r2.rowsWritten + r3.rowsWritten;
    console.log(
      `  3 separate INSERTs: ${r1.rowsWritten} + ${r2.rowsWritten} + ${r3.rowsWritten} = ${total}`,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("batch INSERT of 3 rows", async () => {
    const stub = freshDO("q7-batch");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    await stub.execSql("CREATE INDEX idx_a ON t(a)");
    const result = await stub.execSql(
      "INSERT INTO t(id, a) VALUES (?, ?), (?, ?), (?, ?)",
      [1, "a1", 2, "a2", 3, "a3"],
    );
    console.log(`  Batch INSERT (3 rows): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q8: Real-world nebula-auth schema ───────────────────────────────────────

describe("Q8: Real-world schema — Instances table", () => {
  it("INSERT into Instances WITH rowid", async () => {
    const stub = freshDO("q8-instances-rowid");
    await stub.execSql(`
      CREATE TABLE Instances(
        instanceName TEXT PRIMARY KEY,
        createdAt INTEGER
      )
    `);
    const result = await stub.execSql(
      "INSERT INTO Instances(instanceName, createdAt) VALUES (?, ?)",
      ["acme-corp", 1700000000],
    );
    console.log(`  Instances (with rowid): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT into Instances WITHOUT ROWID", async () => {
    const stub = freshDO("q8-instances-no-rowid");
    await stub.execSql(`
      CREATE TABLE Instances(
        instanceName TEXT PRIMARY KEY,
        createdAt INTEGER
      ) WITHOUT ROWID
    `);
    const result = await stub.execSql(
      "INSERT INTO Instances(instanceName, createdAt) VALUES (?, ?)",
      ["acme-corp", 1700000000],
    );
    console.log(`  Instances WITHOUT ROWID: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

describe("Q8: Real-world schema — Emails table", () => {
  it("INSERT into Emails WITH rowid", async () => {
    const stub = freshDO("q8-emails-rowid");
    await stub.execSql(`
      CREATE TABLE Emails(
        email TEXT NOT NULL,
        instanceName TEXT NOT NULL,
        isAdmin INTEGER,
        createdAt INTEGER,
        PRIMARY KEY (email, instanceName)
      )
    `);
    await stub.execSql("CREATE INDEX idx_Emails_instanceName ON Emails(instanceName)");
    const result = await stub.execSql(
      "INSERT INTO Emails(email, instanceName, isAdmin, createdAt) VALUES (?, ?, ?, ?)",
      ["user@example.com", "acme-corp", 0, 1700000000],
    );
    console.log(`  Emails (with rowid): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT into Emails WITHOUT ROWID", async () => {
    const stub = freshDO("q8-emails-no-rowid");
    await stub.execSql(`
      CREATE TABLE Emails(
        email TEXT NOT NULL,
        instanceName TEXT NOT NULL,
        isAdmin INTEGER,
        createdAt INTEGER,
        PRIMARY KEY (email, instanceName)
      ) WITHOUT ROWID
    `);
    await stub.execSql("CREATE INDEX idx_Emails_instanceName ON Emails(instanceName)");
    const result = await stub.execSql(
      "INSERT INTO Emails(email, instanceName, isAdmin, createdAt) VALUES (?, ?, ?, ?)",
      ["user@example.com", "acme-corp", 0, 1700000000],
    );
    console.log(`  Emails WITHOUT ROWID: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("UPDATE Emails.isAdmin WITHOUT ROWID", async () => {
    const stub = freshDO("q8-emails-update-no-rowid");
    await stub.execSql(`
      CREATE TABLE Emails(
        email TEXT NOT NULL,
        instanceName TEXT NOT NULL,
        isAdmin INTEGER,
        createdAt INTEGER,
        PRIMARY KEY (email, instanceName)
      ) WITHOUT ROWID
    `);
    await stub.execSql("CREATE INDEX idx_Emails_instanceName ON Emails(instanceName)");
    await stub.execSql(
      "INSERT INTO Emails(email, instanceName, isAdmin, createdAt) VALUES (?, ?, ?, ?)",
      ["user@example.com", "acme-corp", 0, 1700000000],
    );
    const result = await stub.execSql(
      "UPDATE Emails SET isAdmin = ? WHERE email = ? AND instanceName = ?",
      [1, "user@example.com", "acme-corp"],
    );
    console.log(`  UPDATE Emails.isAdmin WITHOUT ROWID: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("DELETE from Emails WITHOUT ROWID", async () => {
    const stub = freshDO("q8-emails-delete-no-rowid");
    await stub.execSql(`
      CREATE TABLE Emails(
        email TEXT NOT NULL,
        instanceName TEXT NOT NULL,
        isAdmin INTEGER,
        createdAt INTEGER,
        PRIMARY KEY (email, instanceName)
      ) WITHOUT ROWID
    `);
    await stub.execSql("CREATE INDEX idx_Emails_instanceName ON Emails(instanceName)");
    await stub.execSql(
      "INSERT INTO Emails(email, instanceName, isAdmin, createdAt) VALUES (?, ?, ?, ?)",
      ["user@example.com", "acme-corp", 0, 1700000000],
    );
    const result = await stub.execSql(
      "DELETE FROM Emails WHERE email = ? AND instanceName = ?",
      ["user@example.com", "acme-corp"],
    );
    console.log(`  DELETE Emails WITHOUT ROWID: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

// ─── Q9: Additional questions ────────────────────────────────────────────────

describe("Q9: Filtered/partial index", () => {
  it("INSERT matching filter", async () => {
    const stub = freshDO("q9-partial-match");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, status INTEGER, data TEXT)");
    await stub.execSql("CREATE INDEX idx_active ON t(data) WHERE status = 1");
    const result = await stub.execSql(
      "INSERT INTO t(id, status, data) VALUES (?, ?, ?)",
      [1, 1, "matches filter"],
    );
    console.log(`  Partial index (filter MATCHES): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT not matching filter", async () => {
    const stub = freshDO("q9-partial-no-match");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, status INTEGER, data TEXT)");
    await stub.execSql("CREATE INDEX idx_active ON t(data) WHERE status = 1");
    const result = await stub.execSql(
      "INSERT INTO t(id, status, data) VALUES (?, ?, ?)",
      [1, 0, "does not match filter"],
    );
    console.log(`  Partial index (filter DOES NOT match): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

describe("Q9: INSERT OR REPLACE", () => {
  it("INSERT OR REPLACE on new row", async () => {
    const stub = freshDO("q9-replace-new");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, val TEXT)");
    const result = await stub.execSql(
      "INSERT OR REPLACE INTO t(id, val) VALUES (?, ?)",
      [1, "first"],
    );
    console.log(`  INSERT OR REPLACE (new row): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT OR REPLACE on existing row", async () => {
    const stub = freshDO("q9-replace-existing");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, val TEXT)");
    await stub.execSql("INSERT INTO t(id, val) VALUES (?, ?)", [1, "first"]);
    const result = await stub.execSql(
      "INSERT OR REPLACE INTO t(id, val) VALUES (?, ?)",
      [1, "replaced"],
    );
    console.log(`  INSERT OR REPLACE (existing row): rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});

describe("Q9: Column count vs write count", () => {
  it("INSERT into 2-column table (no extra indexes)", async () => {
    const stub = freshDO("q9-cols-2");
    await stub.execSql("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const result = await stub.execSql("INSERT INTO t(id, a) VALUES (?, ?)", [1, "a"]);
    console.log(`  2 columns: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT into 5-column table (no extra indexes)", async () => {
    const stub = freshDO("q9-cols-5");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, d TEXT)",
    );
    const result = await stub.execSql(
      "INSERT INTO t(id, a, b, c, d) VALUES (?, ?, ?, ?, ?)",
      [1, "a", "b", "c", "d"],
    );
    console.log(`  5 columns: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it("INSERT into 10-column table (no extra indexes)", async () => {
    const stub = freshDO("q9-cols-10");
    await stub.execSql(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, d TEXT, e TEXT, f TEXT, g TEXT, h TEXT, i TEXT)",
    );
    const result = await stub.execSql(
      "INSERT INTO t(id, a, b, c, d, e, f, g, h, i) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1, "a", "b", "c", "d", "e", "f", "g", "h", "i"],
    );
    console.log(`  10 columns: rowsWritten=${result.rowsWritten}`);
    expect(result.rowsWritten).toBeGreaterThan(0);
  });
});
