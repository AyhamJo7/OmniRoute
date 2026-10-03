import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ComboLike,
  HandleComboChatOptions,
} from "../../../../open-sse/services/combo/types.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-dispatch-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../../src/lib/db/core.ts");
const profiles = await import("../../../../src/lib/db/agentProfiles.ts");
const combos = await import("../../../../src/lib/db/combos.ts");
const flags = await import("../../../../src/lib/db/featureFlags.ts");
const resolver = await import("../../../../src/lib/agent-profiles/resolver.ts");
const guard = await import("../../../../src/lib/agent-profiles/dispatch-guard.ts");
const access = await import("../../../../src/lib/agent-profiles/access.ts");
const { handleComboChat } = await import("../../../../open-sse/services/combo.ts");
let calls: Array<{ body: Record<string, unknown>; model: string }> = [];
const log = { info() {}, warn() {}, error() {}, debug() {} };
const definition = {
  slug: "reviewer",
  name: "Reviewer",
  targetComboId: "target",
  instructions: "ROLE",
  injection: "server",
};
async function options(): Promise<HandleComboChatOptions> {
  const combo = await resolver.resolveAgentProfileCombo("agent/reviewer");
  assert.ok(combo);
  return {
    combo,
    allCombos: await resolver.appendRoutingAgentProfiles((await combos.getCombos()) as ComboLike[]),
    body: {
      messages: [
        { role: "system", content: "native tools" },
        { role: "user", content: "task" },
      ],
    },
    log,
    handleSingleModel: async (body, model) => {
      calls.push({ body, model });
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
    isModelAvailable: async () => true,
  };
}
test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory);
  calls = [];
  await combos.createCombo({ id: "target", name: "work", models: ["mock/model"] });
  profiles.createAgentProfile(definition);
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("real nested combo execution retains client instructions, injects role and traces", async () => {
  const response = await handleComboChat(await options());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "mock/model");
  assert.match(JSON.stringify(calls[0].body), /native tools/);
  assert.match(JSON.stringify(calls[0].body), /ROLE/);
  assert.ok(response.headers.get("x-omniroute-combo-trace"));
});

test("flag off and disabled, deleted or orphaned profiles never call providers", async () => {
  const profile = profiles.getAgentProfileForAlias("agent/reviewer")!;
  const initial = await options();
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  assert.equal((await handleComboChat(initial)).status, 404);
  for (const alias of [
    "agent/reviewer",
    "AGENT/REVIEWER",
    profile.id,
    `combo/${profile.id}`,
    "agent/reviewer [1m]",
  ]) {
    assert.equal(
      access.rejectUnavailableAgentRequest(alias, "http://localhost/v1/messages")?.status,
      404
    );
  }
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "true");
  profiles.updateAgentProfile(profile.id, profile.revision, { ...definition, enabled: false });
  assert.equal((await handleComboChat(await options())).status, 404);
  profiles.deleteAgentProfile(profile.id, profile.revision + 1);
  assert.equal((await handleComboChat(await options())).status, 404);
  assert.equal(calls.length, 0);
});

test("revision, deletion and target replacement invalidate admitted attempts", async () => {
  const admitted = await guard.prepareAgentDispatch(await options());
  const profile = profiles.getAgentProfileForAlias("agent/reviewer")!;
  profiles.updateAgentProfile(profile.id, profile.revision, {
    ...definition,
    instructions: "changed",
  });
  assert.equal((await admitted.options.handleSingleModel({}, "mock/model"))?.status, 409);
  const refreshed = await guard.prepareAgentDispatch(await options());
  await combos.deleteCombo("target");
  await combos.createCombo({ id: "replacement", name: "work", models: ["mock/paid"] });
  assert.equal((await refreshed.options.handleSingleModel({}, "mock/model"))?.status, 409);
  assert.equal((await handleComboChat(await options())).status, 404);
  assert.equal(calls.length, 0);
});

test("key policy needs both alias and target, exact slash rules do not imply a glob", async () => {
  for (const rules of [[], ["agent/*", "work"], ["agent/reviewer"], ["work"]]) {
    assert.equal(
      (await handleComboChat({ ...(await options()), apiKeyAllowedCombos: rules })).status,
      403
    );
  }
  assert.equal(
    (
      await handleComboChat({
        ...(await options()),
        apiKeyAllowedCombos: ["agent/reviewer", "work"],
      })
    ).status,
    200
  );
  assert.equal(
    (await handleComboChat({ ...(await options()), apiKeyAllowedCombos: ["combo/*"] })).status,
    200
  );
  assert.equal(calls.length, 2);
});

test("every graph path is checked, shared execute paths cannot mask flatten bypasses", async () => {
  const initial = await options();
  const execute: ComboLike = {
    name: "execute",
    models: [{ kind: "combo-ref", comboName: "agent/reviewer" }],
    config: { nestedComboMode: "execute" },
  };
  const flatten: ComboLike = {
    name: "flatten",
    models: [{ kind: "combo-ref", comboName: "agent/reviewer" }],
  };
  const root: ComboLike = {
    name: "root",
    models: [
      { kind: "combo-ref", comboName: "execute" },
      { kind: "combo-ref", comboName: "flatten" },
    ],
    config: { nestedComboMode: "execute" },
  };
  const allCombos = [...(initial.allCombos as ComboLike[]), execute, flatten];
  assert.equal((await handleComboChat({ ...initial, combo: root, allCombos })).status, 400);
  assert.equal(guard.comboGraphContainsAgentProfile({ combo: root, allCombos }), true);
  assert.equal(calls.length, 0);
});

test("ownership cannot be forged and unsupported media rejects before dispatch", async () => {
  const initial = await options();
  assert.equal(
    (await handleComboChat({ ...initial, combo: JSON.parse(JSON.stringify(initial.combo)) }))
      .status,
    404
  );
  for (const endpoint of [
    "embeddings",
    "audio/speech",
    "images/generations",
    "internal/codex-responses-ws",
  ]) {
    assert.equal(
      access.rejectUnavailableAgentRequest("agent/reviewer", `http://localhost/v1/${endpoint}`)
        ?.status,
      404
    );
  }
  assert.equal(
    access.rejectUnavailableAgentRequest("agent/ordinary", "http://localhost/v1/embeddings"),
    null
  );
  assert.equal(calls.length, 0);
});

test("provider-scoped embeddings cannot hide an owned UUID behind their provider prefix", async () => {
  const profile = profiles.getAgentProfileForAlias("agent/reviewer")!;
  const { POST } =
    await import("../../../../src/app/api/v1/providers/[provider]/embeddings/route.ts");
  const response = await POST(
    new Request("http://localhost/v1/providers/openai/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: profile.id, input: "fixture" }),
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-omniroute-agent-denied"), "1");
  assert.equal(
    access.rejectUnavailableAgentRequest(
      "openai/unowned",
      "http://localhost/v1/providers/openai/embeddings"
    ),
    null
  );
  assert.equal(calls.length, 0);
});

test("denied forced tools and excessive cache boundaries are terminal before provider calls", async () => {
  const profile = profiles.getAgentProfileForAlias("agent/reviewer")!;
  profiles.updateAgentProfile(profile.id, profile.revision, {
    ...definition,
    toolAllowlist: ["Read"],
  });
  const initial = await options();
  const response = await handleComboChat({
    ...initial,
    body: {
      ...initial.body,
      tools: [{ name: "Bash" }],
      tool_choice: { type: "tool", name: "Bash" },
    },
  });
  assert.equal(response.status, 400);
  const cached = await options();
  const cacheResponse = await handleComboChat({
    ...cached,
    body: {
      system: Array.from({ length: 5 }, (_, index) => ({
        type: "text",
        text: String(index),
        cache_control: { type: "ephemeral" },
      })),
      messages: [],
    },
  });
  assert.equal(cacheResponse.status, 400);
  assert.equal(calls.length, 0);
});

test("an admitted stream finishes while later requests observe the kill switch", async () => {
  const initial = await options();
  const response = await handleComboChat({
    ...initial,
    body: { ...initial.body, stream: true },
    handleSingleModel: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
  });
  flags.setFeatureFlagOverride("AGENT_PROFILES_ENABLED", "false");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ok/);
  assert.equal((await handleComboChat(await options())).status, 404);
});
