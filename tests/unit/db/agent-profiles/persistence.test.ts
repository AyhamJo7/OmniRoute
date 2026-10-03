import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-profile-db-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../../src/lib/db/core.ts");
const profiles = await import("../../../../src/lib/db/agentProfiles.ts");
const combos = await import("../../../../src/lib/db/combos.ts");
const { AgentProfileError } = await import("../../../../src/lib/agent-profiles/errors.ts");

const definition = {
  slug: "reviewer",
  name: "Reviewer",
  role: "reviewer",
  targetComboId: "target",
};

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory);
  await combos.createCombo({ id: "target", name: "work", models: ["mock/model"] });
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("creation reserves case, UUID, prefix and context aliases without adding a combo", async () => {
  const before = await combos.getCombos();
  const profile = profiles.createAgentProfile(definition);
  for (const alias of [
    "agent/reviewer",
    "AGENT/REVIEWER",
    "combo/agent/reviewer",
    profile.id,
    `combo/${profile.id}`,
    "agent/reviewer [500k]",
  ]) {
    assert.equal(profiles.getAgentProfileForAlias(alias)?.id, profile.id);
  }
  assert.equal(profiles.getAgentProfileForAlias("agent/unknown"), null);
  assert.deepEqual(await combos.getCombos(), before);
  assert.equal(profiles.listAgentProfiles().total, 1);
});

test("aliases cannot overwrite an existing ordinary agent-prefixed combo", async () => {
  await combos.createCombo({ name: "AGENT/REVIEWER", models: ["mock/other"] });
  const before = await combos.getCombos();
  assert.throws(() => profiles.createAgentProfile(definition));
  assert.equal(profiles.listAgentProfiles().total, 0);
  assert.equal(
    core.getDbInstance().prepare("SELECT COUNT(*) AS count FROM agent_profile_aliases").get().count,
    0
  );
  assert.deepEqual(await combos.getCombos(), before);
});

test("generic insert, update and JSON payload forgery cannot shadow owned aliases", async () => {
  const profile = profiles.createAgentProfile(definition);
  for (const alias of [
    "agent/reviewer",
    "AGENT/REVIEWER",
    "combo/agent/reviewer",
    profile.id,
    "agent/reviewer[1m]",
  ]) {
    await assert.rejects(combos.createCombo({ name: alias, models: ["mock/evil"] }));
    await assert.rejects(combos.updateCombo("target", { name: alias }));
  }
  const db = core.getDbInstance();
  assert.throws(() =>
    db
      .prepare("UPDATE combos SET data = ? WHERE id = ?")
      .run(JSON.stringify({ name: "agent/reviewer", models: ["mock/evil"] }), "target")
  );
  assert.equal((await combos.getComboById("target"))?.name, "work");
});

test("revision conflicts and immutable slug updates leave no partial state", () => {
  const profile = profiles.createAgentProfile(definition);
  const next = profiles.updateAgentProfile(profile.id, 1, { ...definition, name: "New label" });
  assert.equal(next.revision, 2);
  assert.throws(
    () => profiles.updateAgentProfile(profile.id, 1, { ...definition, name: "Stale" }),
    (error: unknown) => error instanceof AgentProfileError && error.code === "conflict"
  );
  assert.throws(
    () => profiles.updateAgentProfile(profile.id, 2, { ...definition, slug: "different" }),
    (error: unknown) => error instanceof AgentProfileError && error.code === "immutable-slug"
  );
  assert.throws(() =>
    profiles.updateAgentProfile(profile.id, 2, { ...definition, targetComboId: "missing" })
  );
  assert.deepEqual(profiles.getAgentProfile(profile.id), next);
});

test("target rename follows UUID; deletion cannot retarget a same-name replacement", async () => {
  const profile = profiles.createAgentProfile(definition);
  await combos.updateCombo("target", { name: "renamed" });
  assert.equal(profiles.getAgentProfile(profile.id)?.targetComboId, "target");
  await combos.deleteCombo("target");
  await combos.createCombo({ id: "replacement", name: "renamed", models: ["mock/other"] });
  assert.equal(profiles.getAgentProfile(profile.id)?.targetComboId, null);
  assert.deepEqual(core.getDbInstance().prepare("PRAGMA foreign_key_check").all(), []);
});

test("delete and database reopen retain terminal alias ownership", () => {
  const profile = profiles.createAgentProfile(definition);
  profiles.deleteAgentProfile(profile.id, profile.revision);
  core.resetDbInstance();
  const deleted = profiles.getAgentProfileForAlias("agent/reviewer");
  assert.equal(deleted?.id, profile.id);
  assert.equal(deleted?.enabled, false);
  assert.ok(deleted?.deletedAt);
  assert.equal(profiles.listAgentProfiles().total, 0);
  assert.throws(() => profiles.createAgentProfile(definition));
});
