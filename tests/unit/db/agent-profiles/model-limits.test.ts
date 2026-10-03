import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-limits-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../../src/lib/db/core.ts");
const combos = await import("../../../../src/lib/db/combos.ts");
const profiles = await import("../../../../src/lib/db/agentProfiles.ts");
const { getAgentModelLimits } =
  await import("../../../../src/lib/agent-profiles/model-capabilities.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("unknown target metadata uses client defaults while explicit combo context clamps output", async () => {
  await combos.createCombo({ id: "unknown", name: "unknown", models: ["fixture/not-registered"] });
  const unknown = profiles.createAgentProfile({
    slug: "unknown",
    name: "Unknown",
    targetComboId: "unknown",
  });
  await combos.createCombo({
    id: "small",
    name: "small",
    models: ["fixture/not-registered"],
    context_length: 4096,
  });
  const small = profiles.createAgentProfile({
    slug: "small",
    name: "Small",
    targetComboId: "small",
  });
  const limits = await getAgentModelLimits([unknown, small]);
  assert.deepEqual(limits[unknown.id], { context: 128000, output: 8192 });
  assert.deepEqual(limits[small.id], { context: 4096, output: 4096 });
  await combos.deleteCombo("unknown");
  assert.equal(
    (await getAgentModelLimits([profiles.getAgentProfile(unknown.id)!]))[unknown.id],
    undefined
  );
});
