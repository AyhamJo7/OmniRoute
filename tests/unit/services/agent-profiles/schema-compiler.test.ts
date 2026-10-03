import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDefinitionSchema,
  agentExportQuerySchema,
  agentListQuerySchema,
  agentSlugSchema,
  MAX_INSTRUCTION_LENGTH,
  type AgentProfile,
} from "../../../../src/lib/agent-profiles/schema.ts";
import {
  compileAgentProfile,
  getAgentProjectionOwner,
} from "../../../../src/lib/agent-profiles/compiler.ts";

const input = { slug: "reviewer", name: "Reviewer", targetComboId: "combo-id", role: "reviewer" };

test("safe role defaults and bounded literal tool names", () => {
  const value = agentDefinitionSchema.parse(input);
  assert.equal(value.injection, "client");
  assert.equal(value.clientAccess, "read-only");
  assert.equal(
    agentDefinitionSchema.parse({ ...input, role: "implementer" }).clientAccess,
    "workspace"
  );
  assert.deepEqual(
    agentDefinitionSchema.parse({ ...input, toolAllowlist: ["Read", "Read"] }).toolAllowlist,
    ["Read"]
  );
  for (const tool of [".*", "(a+)+$", "Bash(git push *)", "../Read", "Read\nWrite"]) {
    assert.equal(
      agentDefinitionSchema.safeParse({ ...input, toolAllowlist: [tool] }).success,
      false
    );
  }
});

test("slug and payload validation reject traversal, secrets, bypass options and oversized prompts", () => {
  for (const slug of ["../reviewer", "Reviewer", "", "a/b", "-reviewer", "a".repeat(64)]) {
    assert.equal(agentSlugSchema.safeParse(slug).success, false);
  }
  assert.equal(agentSlugSchema.safeParse("a".repeat(63)).success, true);
  for (const extra of ["apiKey", "permissionMode", "hooks", "id", "revision"]) {
    assert.equal(agentDefinitionSchema.safeParse({ ...input, [extra]: "unsafe" }).success, false);
  }
  assert.equal(
    agentDefinitionSchema.safeParse({
      ...input,
      instructions: "x".repeat(MAX_INSTRUCTION_LENGTH + 1),
    }).success,
    false
  );
});

test("query bounds prevent unbounded management reads and invalid export selection", () => {
  assert.equal(agentListQuerySchema.safeParse({ limit: 201 }).success, false);
  assert.equal(agentListQuerySchema.safeParse({ offset: -1 }).success, false);
  assert.equal(agentExportQuerySchema.safeParse({ format: "shell", ids: [] }).success, false);
  assert.equal(
    agentExportQuerySchema.safeParse({ format: "json", ids: ["../secret"] }).success,
    false
  );
});

test("compiler retains target execution and private ownership without leaking instructions or credentials", () => {
  const profile: AgentProfile = {
    ...agentDefinitionSchema.parse({ ...input, instructions: "private role instructions" }),
    id: "40d831ac-e70b-4c99-aa27-c422599432a2",
    revision: 2,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    deletedAt: null,
  };
  const before = JSON.stringify(profile);
  const combo = compileAgentProfile(profile, "renamed-target");
  assert.equal(combo.name, "agent/reviewer");
  assert.equal(combo.config?.nestedComboMode, "execute");
  assert.deepEqual(getAgentProjectionOwner(combo), {
    id: profile.id,
    revision: 2,
    targetComboId: "combo-id",
  });
  assert.deepEqual(getAgentProjectionOwner({ ...combo }), getAgentProjectionOwner(combo));
  assert.equal(getAgentProjectionOwner(JSON.parse(JSON.stringify(combo))), null);
  assert.equal(
    getAgentProjectionOwner({
      name: "agent/reviewer",
      models: [],
      config: { agentProfileId: profile.id },
    }),
    null
  );
  assert.equal(JSON.stringify(combo).includes("private role instructions"), false);
  assert.equal(JSON.stringify(profile), before);
});
