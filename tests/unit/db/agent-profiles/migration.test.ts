import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-profile-migration-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../../src/lib/db/core.ts");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const golden = JSON.parse(
  fs.readFileSync(path.join(root, "tests/fixtures/agent-profiles/v3851-schema.json"), "utf8")
);
const migration = fs.readFileSync(
  path.join(root, "src/lib/db/migrations/197_agent_profiles.sql"),
  "utf8"
);
const newObjects = new Set([
  "agent_profiles",
  "agent_profile_aliases",
  "idx_agent_profiles_combo",
  "idx_agent_profile_aliases_profile",
  "agent_alias_collision",
  "combo_agent_alias_insert",
  "combo_agent_alias_update",
]);

function schema() {
  return getDbInstance()
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all() as Array<{ name: string }>;
}

test.after(() => {
  resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("fresh migration preserves every existing schema object and adds only the owned profile schema", () => {
  const objects = schema();
  assert.deepEqual(
    objects.filter((row) => !newObjects.has(row.name)),
    golden.objects
  );
  assert.deepEqual(
    new Set(objects.filter((row) => newObjects.has(row.name)).map((row) => row.name)),
    newObjects
  );
  assert.deepEqual(getDbInstance().prepare("PRAGMA foreign_key_check").all(), []);
});

test("migration rerun is idempotent and retains existing combo data", () => {
  const db = getDbInstance();
  const timestamp = "2026-10-03T00:00:00.000Z";
  db.prepare(
    "INSERT INTO combos(id, name, data, created_at, updated_at) VALUES(?, ?, ?, ?, ?)"
  ).run("sentinel", "unchanged", '{"models":["mock/model"]}', timestamp, timestamp);
  const beforeSchema = schema();
  const beforeRows = db.prepare("SELECT * FROM combos").all();
  db.transaction(() => db.exec(migration))();
  assert.deepEqual(schema(), beforeSchema);
  assert.deepEqual(db.prepare("SELECT * FROM combos").all(), beforeRows);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
