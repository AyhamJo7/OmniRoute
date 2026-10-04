import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleAgenticPipelineChat,
  hasTrailingToolResult,
  countToolResultTurns,
} from "../../../../open-sse/services/agenticPipeline.ts";
import type { HandleSingleModel } from "../../../../open-sse/services/combo/types.ts";

const steps = [{ model: "fixture/planner" }, { model: "fixture/executor" }];
const log = { info() {}, warn() {}, debug() {}, error() {} };
function response(text: string) {
  return Response.json({ choices: [{ message: { role: "assistant", content: text } }] });
}
const original = {
  messages: [{ role: "user", content: "Read the acceptance fixture and report its content" }],
  tools: [{ name: "Read" }],
  stream: false,
};
const toolResponse = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "read-1", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
    },
  ],
};

test("bounded two-role spike: only the client reads a fixture, then planner reports its evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-crew-client-"));
  const fixture = path.join(directory, "acceptance.txt");
  fs.writeFileSync(fixture, "ACTUAL_FIXTURE_EVIDENCE");
  const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
  let clientTools = 0;
  const handle: HandleSingleModel = async (body, model) => {
    calls.push({ body, model });
    if (model === "fixture/executor") return Response.json(toolResponse);
    if (body.stream === false && !body.tools) {
      return response(
        hasTrailingToolResult(body)
          ? "OMNIROUTE_ROUTE: FINAL\nReport the evidence"
          : "OMNIROUTE_ROUTE: TOOLS\nRead acceptance.txt"
      );
    }
    return response("ACTUAL_FIXTURE_EVIDENCE");
  };
  try {
    const first = await handleAgenticPipelineChat({
      body: original,
      steps,
      handleSingleModel: handle,
      log,
      config: { maxToolRounds: 1 },
    });
    assert.equal(first.status, 200);
    assert.equal(clientTools, 0, "gateway returned a tool call without executing it");
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.tool_calls[0].function.name, "Read");
    const evidence = fs.readFileSync(fixture, "utf8");
    clientTools += 1;
    const continuation = {
      ...original,
      stream: true,
      messages: [
        ...original.messages,
        firstBody.choices[0].message,
        { role: "tool", tool_call_id: "read-1", content: evidence },
      ],
    };
    assert.equal(hasTrailingToolResult(continuation), true);
    const final = await handleAgenticPipelineChat({
      body: continuation,
      steps,
      handleSingleModel: handle,
      log,
      config: { maxToolRounds: 1 },
    });
    assert.match(await final.text(), /ACTUAL_FIXTURE_EVIDENCE/);
    assert.deepEqual(
      calls.map((call) => call.model),
      ["fixture/planner", "fixture/executor", "fixture/planner", "fixture/planner"]
    );
    assert.equal(clientTools, 1);
    for (const call of calls)
      assert.match(JSON.stringify(call.body), /Read the acceptance fixture/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("client tool denial is returned as evidence and cannot bypass the completed-round bound", async () => {
  const calls: string[] = [];
  const continuation = {
    ...original,
    messages: [
      ...original.messages,
      { role: "tool", tool_call_id: "read-1", content: "DENIED_BY_CLIENT" },
    ],
  };
  const response = await handleAgenticPipelineChat({
    body: continuation,
    steps,
    log,
    config: { maxToolRounds: 1 },
    handleSingleModel: async (body, model) => {
      calls.push(model);
      assert.match(JSON.stringify(body), /DENIED_BY_CLIENT/);
      return Response.json({
        choices: [{ message: { content: "OMNIROUTE_ROUTE: TOOLS\nTry another tool" } }],
      });
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["fixture/planner", "fixture/planner"]);
});

test("duplicates and a lost transcript have no durable exactly-once mission guarantee", async () => {
  let executorCalls = 0;
  const handle: HandleSingleModel = async (_body, model) => {
    if (model === "fixture/executor") {
      executorCalls++;
      return Response.json(toolResponse);
    }
    return response("OMNIROUTE_ROUTE: TOOLS\nRead");
  };
  for (let duplicate = 0; duplicate < 2; duplicate++) {
    await handleAgenticPipelineChat({
      body: structuredClone(original),
      steps,
      handleSingleModel: handle,
      log,
      config: { maxToolRounds: 1 },
    });
  }
  assert.equal(executorCalls, 2);
  assert.equal(
    countToolResultTurns(structuredClone(original)),
    0,
    "restart without transcript loses the round count"
  );
});

test("provider failure before output and cancellation from the caller do not execute tools", async () => {
  let executorCalls = 0;
  const failed = await handleAgenticPipelineChat({
    body: original,
    steps,
    log,
    handleSingleModel: async (_body, model) => {
      if (model === "fixture/executor") executorCalls++;
      return new Response("unavailable", { status: 503 });
    },
  });
  assert.equal(failed.status, 503);
  assert.equal(executorCalls, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      handleAgenticPipelineChat({
        body: original,
        steps,
        log,
        handleSingleModel: async () => {
          controller.signal.throwIfAborted();
          return response("unexpected");
        },
      }),
    { name: "AbortError" }
  );
});

test("no-tools mode is one planner call; malformed continuation defaults to a final turn", async () => {
  const calls: string[] = [];
  const handle: HandleSingleModel = async (_body, model) => {
    calls.push(model);
    return response("plain response without route marker");
  };
  await handleAgenticPipelineChat({
    body: { messages: original.messages },
    steps,
    log,
    handleSingleModel: handle,
  });
  assert.deepEqual(calls, ["fixture/planner"]);
  calls.length = 0;
  await handleAgenticPipelineChat({
    body: {
      ...original,
      messages: [...original.messages, { role: "tool", content: "result", tool_call_id: "read-1" }],
    },
    steps,
    log,
    handleSingleModel: handle,
  });
  assert.deepEqual(calls, ["fixture/planner", "fixture/planner"]);
});

test("historical cache and continuation hypotheses are not reproduced by standard native fixtures", async () => {
  const body = {
    system: [{ type: "text", text: "native", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {},
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "actual" }],
      },
    ],
  };
  assert.equal(hasTrailingToolResult(body), true);
  await handleAgenticPipelineChat({
    body,
    steps,
    log,
    handleSingleModel: async (request) => {
      assert.ok((JSON.stringify(request).match(/cache_control/g) ?? []).length <= 4);
      return response("OMNIROUTE_ROUTE: FINAL\nactual");
    },
  });
  const fresh = {
    ...body,
    messages: [...body.messages, { role: "user", content: "A fresh task" }],
  };
  assert.equal(
    hasTrailingToolResult(fresh),
    false,
    "a later user request deliberately starts a fresh turn"
  );
});
