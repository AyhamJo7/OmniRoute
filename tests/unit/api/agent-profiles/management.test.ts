import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-api-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../../src/lib/db/core.ts");
const combos = await import("../../../../src/lib/db/combos.ts");
const profiles = await import("../../../../src/lib/db/agentProfiles.ts");
const flags = await import("../../../../src/lib/db/featureFlags.ts");
const settings = await import("../../../../src/lib/db/settings.ts");
const collection = await import("../../../../src/app/api/agent-profiles/route.ts");
const item = await import("../../../../src/app/api/agent-profiles/[id]/route.ts");
const imports = await import("../../../../src/app/api/agent-profiles/import/route.ts");
const exports = await import("../../../../src/app/api/agent-profiles/export/route.ts");
const templates = await import("../../../../src/app/api/agent-profiles/templates/route.ts");
const definition = { slug: "reviewer", name: "Reviewer", targetComboId: "work", role: "reviewer" };
function request(body?: unknown, url = "http://localhost/api/agent-profiles"): Request {
  return new Request(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  );
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory);
  await combos.createCombo({ id: "work", name: "work", models: ["mock/model"] });
  await settings.updateSettings({ requireLogin: false });
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("CRUD routes validate inputs and revisions, paginate and preserve unrelated combos", async () => {
  const before = await combos.getCombos();
  const created = await collection.POST(request(definition));
  assert.equal(created.status, 201);
  const profile = await created.json();
  assert.equal((await collection.POST(request(definition))).status, 409);
  assert.equal(
    (await collection.GET(request(undefined, "http://localhost/api/agent-profiles?limit=1")))
      .status,
    200
  );
  assert.equal((await item.GET(request(), context(profile.id))).status, 200);
  const updated = await item.PUT(
    request({ revision: profile.revision, profile: { ...definition, name: "Updated" } }),
    context(profile.id)
  );
  assert.equal(updated.status, 200);
  assert.equal(
    (
      await item.PUT(
        request({ revision: profile.revision, profile: definition }),
        context(profile.id)
      )
    ).status,
    409
  );
  assert.equal(
    (await item.DELETE(request({ revision: profile.revision }), context(profile.id))).status,
    409
  );
  assert.equal(
    (await item.DELETE(request({ revision: profile.revision + 1 }), context(profile.id))).status,
    204
  );
  assert.equal((await item.GET(request(), context(profile.id))).status, 404);
  assert.deepEqual(await combos.getCombos(), before);
});

test("invalid JSON, oversized bodies and protected fields are rejected without leaking details", async () => {
  const cases = [
    request({ ...definition, apiKey: "secret" }),
    request({ ...definition, slug: "../x" }),
    request({ ...definition, targetComboId: "missing" }),
    new Request("http://localhost/api/agent-profiles", { method: "POST", body: "{" }),
  ];
  for (const input of cases) {
    const response = await collection.POST(input);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, /secret|SQLITE|at \/|stack/i);
  }
  assert.equal(
    (
      await collection.POST(
        new Request("http://localhost/api/agent-profiles", {
          method: "POST",
          body: "x".repeat(1_048_577),
        })
      )
    ).status,
    413
  );
  assert.equal(
    (await collection.GET(request(undefined, "http://localhost/api/agent-profiles?limit=201")))
      .status,
    400
  );
  assert.equal((await item.GET(request(), context("../x"))).status, 400);
  assert.equal(profiles.listAgentProfiles().total, 0);
});

test("all management routes fail closed with the feature off after records exist", async () => {
  const profile = profiles.createAgentProfile(definition);
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  const responses = await Promise.all([
    collection.GET(request()),
    collection.POST(request(definition)),
    item.GET(request(), context(profile.id)),
    item.PUT(request({ revision: 1, profile: definition }), context(profile.id)),
    item.DELETE(request({ revision: 1 }), context(profile.id)),
    imports.POST(request({ version: 1, profiles: [definition] })),
    exports.POST(request({ format: "json" })),
    templates.GET(request()),
  ]);
  for (const response of responses) assert.equal(response.status, 404);
  assert.equal(profiles.getAgentProfile(profile.id)?.revision, 1);
});

test("management auth precedes feature disclosure and blocks unauthenticated writes", async () => {
  await settings.updateSettings({ requireLogin: true, password: "test-only-password" });
  const response = await collection.POST(request(definition));
  assert.equal(response.status, 401);
  assert.equal(profiles.listAgentProfiles().total, 0);
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  assert.equal((await collection.GET(request())).status, 401);
});

test("batch import is atomic across alias collisions, invalid targets and duplicate slugs", async () => {
  for (const second of [definition, { ...definition, slug: "other", targetComboId: "missing" }]) {
    const response = await imports.POST(request({ version: 1, profiles: [definition, second] }));
    assert.ok([400, 409].includes(response.status));
    assert.equal(profiles.listAgentProfiles().total, 0);
  }
  assert.equal(
    (
      await imports.POST(
        request({ version: 1, profiles: [definition, { ...definition, slug: "other" }] })
      )
    ).status,
    201
  );
  assert.equal(profiles.listAgentProfiles().total, 2);
});

test("client exports select exact profiles, validate URLs and never include credentials", async () => {
  const profile = profiles.createAgentProfile(definition);
  for (const format of ["claude-code", "opencode", "json"]) {
    const response = await exports.POST(request({ format, ids: [profile.id] }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.files.length, 1);
    assert.doesNotMatch(
      JSON.stringify(data),
      /oauth|refreshToken|accessToken|provider_connections/
    );
  }
  assert.equal(
    (await exports.POST(request({ format: "json", ids: ["00000000-0000-4000-8000-000000000001"] })))
      .status,
    404
  );
  assert.equal(
    (await exports.POST(request({ format: "opencode", baseUrl: "https://secret@example.com" })))
      .status,
    400
  );
  assert.equal((await templates.GET(request())).status, 200);
});
