import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-catalog-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
const core = await import("../../../../src/lib/db/core.ts");
const combos = await import("../../../../src/lib/db/combos.ts");
const profiles = await import("../../../../src/lib/db/agentProfiles.ts");
const flags = await import("../../../../src/lib/db/featureFlags.ts");
const { invalidateModelCatalogCache } = await import("../../../../src/lib/db/readCache.ts");
const catalog = await import("../../../../src/app/api/v1/models/catalog.ts");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const golden = JSON.parse(
  fs.readFileSync(path.join(root, "tests/fixtures/agent-profiles/v3851-catalog.json"), "utf8")
);
const originalNow = Date.now;

test.after(() => {
  Date.now = originalNow;
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("normal model catalog is byte-identical to the untouched tag with profiles off, on and tombstoned", async () => {
  Date.now = () => golden.epochMs;
  await combos.createCombo({
    id: "sentinel",
    name: "agent/ordinary",
    models: ["fixture/not-registered"],
  });
  await combos.createCombo({ id: "target", name: "work", models: ["fixture/not-registered"] });
  const ordinary = await combos.getCombos();
  async function matchesGolden() {
    invalidateModelCatalogCache();
    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(crypto.createHash("sha256").update(body).digest("hex"), golden.sha256);
    assert.equal(JSON.parse(body).data.length, golden.modelCount);
    assert.deepEqual(await combos.getCombos(), ordinary);
  }
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  await matchesGolden();
  const profile = profiles.createAgentProfile({
    slug: "reviewer",
    name: "Reviewer",
    targetComboId: "target",
  });
  await matchesGolden();
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
  await matchesGolden();
  profiles.deleteAgentProfile(profile.id, profile.revision);
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  core.resetDbInstance();
  await matchesGolden();
});
