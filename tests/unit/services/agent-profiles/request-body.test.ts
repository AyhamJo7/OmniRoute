import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareAgentRequestBody,
  exceedsAgentCacheBoundaries,
} from "../../../../src/lib/agent-profiles/request-body.ts";
import {
  agentDefinitionSchema,
  type AgentProfile,
} from "../../../../src/lib/agent-profiles/schema.ts";

function profile(injection: AgentProfile["injection"] = "server"): AgentProfile {
  return {
    ...agentDefinitionSchema.parse({
      slug: "reviewer",
      name: "Reviewer",
      targetComboId: "work",
      instructions: "ROLE",
      injection,
    }),
    id: "id",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
    deletedAt: null,
  };
}

test("cache admission counts protocol markers without interpreting tool input/schema properties", () => {
  const cached = { type: "text", text: "native", cache_control: { type: "ephemeral" } };
  assert.equal(
    exceedsAgentCacheBoundaries({ messages: [{ role: "user", content: Array(5).fill(cached) }] }),
    true
  );
  assert.equal(exceedsAgentCacheBoundaries({ system: Array(4).fill(cached) }), false);
  assert.equal(
    exceedsAgentCacheBoundaries({
      cache_control: { type: "ephemeral" },
      system: Array(4).fill(cached),
    }),
    true
  );
  let schema: Record<string, unknown> = { cache_control: { type: "string" } };
  for (let depth = 0; depth < 20_000; depth++) schema = { nested: schema };
  assert.equal(
    exceedsAgentCacheBoundaries({
      system: Array(4).fill(cached),
      tools: [{ name: "Read", input_schema: schema }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", input: { cache_control: "user data" } }],
        },
      ],
    }),
    false
  );
  assert.equal(
    exceedsAgentCacheBoundaries({
      messages: [
        { role: "user", content: [{ type: "tool_result", content: Array(5).fill(cached) }] },
      ],
    }),
    true
  );
});

test("Anthropic injection retains four original cache boundaries and native tool instructions", () => {
  const inbound = {
    system: [
      { type: "text", text: "native", cache_control: { type: "ephemeral" } },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "request", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  const before = JSON.stringify(inbound);
  const current = {
    ...inbound,
    messages: [{ role: "system", content: "target override" }, ...inbound.messages],
  };
  const body = prepareAgentRequestBody(inbound, current, profile());
  assert.equal((JSON.stringify(body).match(/cache_control/g) || []).length, 4);
  assert.match(JSON.stringify(body.system), /ROLE/);
  assert.match(JSON.stringify(body.system), /native/);
  assert.match(JSON.stringify(body.system), /target override/);
  assert.equal(
    (body.messages as Array<{ role: string }>).some((message) => message.role === "system"),
    false
  );
  assert.equal(JSON.stringify(inbound), before);
  assert.deepEqual(prepareAgentRequestBody(inbound, body, profile()), body);
});

test("OpenAI and Responses preserve native prompts when the existing target overrides them", () => {
  const inbound = {
    messages: [
      { role: "system", content: "native tools" },
      { role: "user", content: "task" },
    ],
  };
  const current = {
    messages: [{ role: "system", content: "target override" }, inbound.messages[1]],
  };
  const body = prepareAgentRequestBody(inbound, current, profile());
  assert.match(JSON.stringify(body), /native tools/);
  assert.match(JSON.stringify(body), /target override/);
  assert.match(JSON.stringify(body), /ROLE/);
  const responses = prepareAgentRequestBody(
    { instructions: "native tools", input: "task" },
    { instructions: "target override", input: "task" },
    profile()
  );
  assert.equal(responses.instructions, "ROLE\n\ntarget override\n\nnative tools");
});

test("client mode does not inject role instructions and both mode avoids duplication", () => {
  const inbound = { messages: [{ role: "system", content: "native tools\nROLE" }] };
  assert.deepEqual(prepareAgentRequestBody(inbound, inbound, profile("both")), inbound);
  const native = { messages: [{ role: "system", content: "native tools" }] };
  assert.deepEqual(prepareAgentRequestBody(native, native, profile("client")), native);
});

test("literal allowlists handle OpenAI, Anthropic and Gemini tools without changing originals", () => {
  const agent = { ...profile(), toolAllowlist: ["Read"] };
  for (const tools of [
    [{ name: "Read" }, { name: "Write" }],
    [
      { type: "function", function: { name: "Read" } },
      { type: "function", function: { name: "Write" } },
    ],
  ]) {
    const inbound = { messages: [], tools };
    const before = JSON.stringify(inbound);
    const body = prepareAgentRequestBody(inbound, inbound, agent);
    assert.equal((body.tools as unknown[]).length, 1);
    assert.equal(JSON.stringify(inbound), before);
  }
  const inbound = {
    systemInstruction: { parts: [{ text: "native" }] },
    tools: [{ functionDeclarations: [{ name: "Read" }, { name: "Write" }] }],
  };
  const body = prepareAgentRequestBody(inbound, inbound, agent);
  assert.equal(JSON.stringify(body).includes('"Write"'), false);
  assert.match(JSON.stringify(body.systemInstruction), /native/);
  assert.match(JSON.stringify(body.systemInstruction), /ROLE/);
});

test("Gemini instructions preserve native and target parts in every injection mode", () => {
  const inbound = { systemInstruction: { parts: [{ text: "native" }] }, contents: [] };
  const current = { systemInstruction: { parts: [{ text: "target" }] }, contents: [] };
  for (const mode of ["client", "server", "both"] as const) {
    const result = prepareAgentRequestBody(inbound, current, profile(mode));
    assert.match(JSON.stringify(result), /native/);
    assert.match(JSON.stringify(result), /target/);
    assert.equal(JSON.stringify(result).includes("ROLE"), mode !== "client");
    assert.deepEqual(prepareAgentRequestBody(inbound, result, profile(mode)), result);
  }
});
