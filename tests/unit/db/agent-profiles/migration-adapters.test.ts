import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { createBetterSqliteAdapter } from "../../../../src/lib/db/adapters/betterSqliteAdapter.ts";
import { createNodeSqliteAdapterFromDatabase } from "../../../../src/lib/db/adapters/nodeSqliteShared.ts";
import { createSqlJsAdapter } from "../../../../src/lib/db/adapters/sqljsAdapter.ts";
import type { SqliteAdapter } from "../../../../src/lib/db/adapters/types.ts";

const migration = fs.readFileSync(
  new URL("../../../../src/lib/db/migrations/197_agent_profiles.sql", import.meta.url),
  "utf8"
);
function probe(adapter: SqliteAdapter): void {
  adapter.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE combos(id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT NOT NULL);"
  );
  adapter.prepare("INSERT INTO combos VALUES (?, ?, ?)").run("target", "work", '{"name":"work"}');
  adapter.exec(migration);
  adapter.exec(migration);
  adapter
    .prepare("INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("profile", "reviewer", "{}", "target", 1, 1, null, "now", "now");
  adapter
    .prepare("INSERT INTO agent_profile_aliases VALUES (?, ?)")
    .run("agent/reviewer", "profile");
  for (const candidate of ["AGENT/REVIEWER", "agent/reviewer [1m]"]) {
    assert.throws(() =>
      adapter
        .prepare("INSERT INTO combos VALUES (?, ?, ?)")
        .run("evil", "ordinary", JSON.stringify({ name: candidate }))
    );
    assert.throws(() =>
      adapter.prepare("UPDATE combos SET name = ? WHERE id = ?").run(candidate, "target")
    );
  }
  assert.equal(
    adapter
      .prepare("UPDATE agent_profiles SET revision = revision + 1 WHERE id = ? AND revision = ?")
      .run("profile", 1).changes,
    1
  );
  assert.equal(
    adapter
      .prepare("UPDATE agent_profiles SET revision = revision + 1 WHERE id = ? AND revision = ?")
      .run("profile", 1).changes,
    0
  );
  assert.throws(
    adapter.transaction(() => {
      adapter
        .prepare("INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("rolled-back", "other", "{}", "target", 1, 1, null, "now", "now");
      adapter.prepare("INSERT INTO agent_profile_aliases VALUES (?, ?)").run("work", "rolled-back");
    })
  );
  assert.equal(
    adapter.prepare("SELECT id FROM agent_profiles WHERE id = ?").get("rolled-back") == null,
    true
  );
  adapter.prepare("DELETE FROM combos WHERE id = ?").run("target");
  assert.equal(
    (
      adapter.prepare("SELECT combo_id FROM agent_profiles WHERE id = ?").get("profile") as {
        combo_id: string | null;
      }
    ).combo_id,
    null
  );
  assert.equal(adapter.prepare("PRAGMA foreign_key_check").all().length, 0);
}
for (const [driver, create] of [
  ["better-sqlite3", () => createBetterSqliteAdapter(new Database(":memory:"))],
  [
    "node:sqlite",
    () => createNodeSqliteAdapterFromDatabase(new DatabaseSync(":memory:"), ":memory:"),
  ],
  ["sql.js", () => createSqlJsAdapter(":memory:")],
] as const) {
  test(`migration preserves ownership, rollback and orphan semantics on ${driver}`, async () => {
    const adapter = await create();
    try {
      probe(adapter);
    } finally {
      adapter.close();
    }
  });
}

test("Bun SQLite applies the same migration and prevents forged JSON aliases", (context) => {
  try {
    execFileSync("bun", ["--version"], { timeout: 5_000, stdio: "pipe" });
  } catch {
    context.skip("Optional Bun runtime is unavailable; Node and SQL.js migration cases run above");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-bun-"));
  const script = path.join(directory, "probe.mjs");
  try {
    fs.writeFileSync(
      script,
      `import { Database } from "bun:sqlite";\nimport assert from "node:assert/strict";\nconst db = new Database(":memory:");\ndb.exec("PRAGMA foreign_keys=ON; CREATE TABLE combos(id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT NOT NULL)");\ndb.exec(${JSON.stringify(migration)});\ndb.exec(${JSON.stringify(migration)});\ndb.query("INSERT INTO combos VALUES (?, ?, ?)").run("work", "work", '{}');\ndb.query("INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("profile", "reviewer", "{}", "work", 1, 1, null, "now", "now");\ndb.query("INSERT INTO agent_profile_aliases VALUES (?, ?)").run("agent/reviewer", "profile");\nassert.throws(() => db.query("INSERT INTO combos VALUES (?, ?, ?)").run("evil", "ordinary", '{"name":"AGENT/REVIEWER [1m]"}'));\ndb.query("DELETE FROM combos WHERE id = ?").run("work");\nassert.equal(db.query("SELECT combo_id FROM agent_profiles").get().combo_id, null);\ndb.close();\n`
    );
    execFileSync("bun", [script], { timeout: 10_000, stdio: "pipe" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
