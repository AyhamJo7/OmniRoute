import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-http-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
process.env.REQUIRE_API_KEY = "false";
process.env.OUTBOUND_SSRF_GUARD_ENABLED = "false";
process.env.API_KEY_SECRET = "isolated-agent-routing-test-secret";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const combos = await import("../../src/lib/db/combos.ts");
const profiles = await import("../../src/lib/db/agentProfiles.ts");
const flags = await import("../../src/lib/db/featureFlags.ts");
const settings = await import("../../src/lib/db/settings.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
let upstreamCalls: Array<Record<string, unknown>> = [];
let upstreamStatus = 200;
const server = http.createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  upstreamCalls.push(body);
  if (upstreamStatus !== 200) {
    outgoing.writeHead(upstreamStatus, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({ error: { message: "fixture unavailable", type: "server_error" } })
    );
    return;
  }
  outgoing.writeHead(200, { "content-type": "application/json" });
  outgoing.end(
    JSON.stringify({
      id: "agent-probe",
      object: "chat.completion",
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: "PROFILE_OK" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const providerId = "openai-compatible-agent-probe";
const definition = {
  slug: "reviewer",
  name: "Reviewer",
  targetComboId: "work",
  instructions: "ROLE_REVIEWER",
  injection: "server",
  role: "reviewer",
};
let connectionId: string;
async function chat(model = "agent/reviewer", key?: string): Promise<Response> {
  return handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "NATIVE_CLIENT" },
          { role: "user", content: "task" },
        ],
        stream: false,
      }),
    })
  );
}
test.beforeEach(async () => {
  assert.equal(await waitForCallLogSaves(10_000), true);
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory);
  upstreamCalls = [];
  upstreamStatus = 200;
  initTranslators();
  await settings.updateSettings({
    requireLogin: false,
    globalFallbackModel: "agent-probe/paid",
    logMaxEntries: 0,
  });
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
  await providers.createProviderNode({
    id: providerId,
    type: "openai-compatible",
    name: "Agent probe",
    prefix: "agent-probe",
    apiType: "chat",
    baseUrl,
  });
  const connection = await providers.createProviderConnection({
    provider: providerId,
    authType: "apikey",
    name: "fixture",
    apiKey: "fixture-only-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, apiType: "chat" },
  });
  connectionId = connection.id;
  await combos.createCombo({
    id: "work",
    name: "work",
    models: ["agent-probe/probe"],
    config: { maxRetries: 0 },
  });
});
test.after(async () => {
  await waitForCallLogSaves(10_000);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("HTTP provider receives additive role instructions through a hidden virtual combo", async () => {
  profiles.createAgentProfile(definition);
  const response = await chat();
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /PROFILE_OK/);
  assert.equal(upstreamCalls.length, 1);
  assert.match(JSON.stringify(upstreamCalls[0]), /ROLE_REVIEWER/);
  assert.match(JSON.stringify(upstreamCalls[0]), /NATIVE_CLIENT/);
  assert.ok(response.headers.get("x-omniroute-combo-trace"));
  assert.equal(
    (await combos.getCombos()).some((combo) => combo.name === "agent/reviewer"),
    false
  );
});

test("every owned alias rejects after kill switch, deletion and reopen without calling upstream", async () => {
  const profile = profiles.createAgentProfile(definition);
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  for (const alias of [
    "agent/reviewer",
    "AGENT/REVIEWER",
    "combo/agent/reviewer",
    profile.id,
    `combo/${profile.id}`,
    "agent/reviewer [1m]",
  ]) {
    assert.equal((await chat(alias)).status, 404);
  }
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
  profiles.deleteAgentProfile(profile.id, profile.revision);
  core.resetDbInstance();
  assert.equal((await chat(profile.id)).status, 404);
  assert.equal(upstreamCalls.length, 0);
});

test("key combo and connection restrictions remain effective at the real dispatch boundary", async () => {
  profiles.createAgentProfile(definition);
  const key = await keys.createApiKey("profile fixture", "test-machine");
  await keys.updateApiKeyPermissions(key.id, {
    allowedCombos: ["agent/reviewer"],
    allowedConnections: [connectionId],
  });
  assert.equal((await chat("agent/reviewer", key.key)).status, 403);
  assert.equal(upstreamCalls.length, 0);
  await keys.updateApiKeyPermissions(key.id, {
    allowedCombos: ["agent/reviewer", "work"],
    allowedConnections: [connectionId],
  });
  const accepted = await chat("agent/reviewer", key.key);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(upstreamCalls.length, 1);
  await keys.updateApiKeyPermissions(key.id, { allowedConnections: ["different-connection"] });
  const denied = await chat("agent/reviewer", key.key);
  assert.equal(denied.ok, false);
  assert.equal(upstreamCalls.length, 1);
});

test("exhausted agent never uses a globally configured unrelated paid fallback", async () => {
  profiles.createAgentProfile(definition);
  upstreamStatus = 503;
  const response = await chat();
  assert.equal(response.ok, false);
  assert.ok(upstreamCalls.length > 0);
  assert.equal(
    upstreamCalls.some((body) => body.model === "paid"),
    false
  );
});
