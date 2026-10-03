import { randomUUID } from "node:crypto";
import { stripContextWindowSuffix } from "@omniroute/open-sse/services/model";
import { AgentProfileError } from "@/lib/agent-profiles/errors";
import {
  agentDefinitionSchema,
  type AgentDefinition,
  type AgentProfile,
} from "@/lib/agent-profiles/schema";
import { getDbInstance } from "./core";

interface ProfileRow {
  id: string;
  slug: string;
  data: string;
  combo_id: string | null;
  enabled: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function readProfile(row: ProfileRow): AgentProfile {
  const definition = agentDefinitionSchema.parse({ ...JSON.parse(row.data), slug: row.slug });
  return {
    ...definition,
    id: row.id,
    targetComboId: row.combo_id,
    enabled: row.enabled === 1,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAgentProfile(id: string): AgentProfile | null {
  const row = getDbInstance().prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as
    ProfileRow | undefined;
  return row ? readProfile(row) : null;
}

/** Alias ownership remains available with the flag off and for deleted profiles. */
export function getAgentProfileForAlias(model: string): AgentProfile | null {
  const db = getDbInstance();
  const query = db.prepare(
    "SELECT p.* FROM agent_profile_aliases a JOIN agent_profiles p ON p.id = a.profile_id WHERE a.alias = ? COLLATE NOCASE"
  );
  const exact = query.get(model) as ProfileRow | undefined;
  if (exact) return readProfile(exact);
  const base = stripContextWindowSuffix(model);
  if (!base || base === model) return null;
  const row = query.get(base) as ProfileRow | undefined;
  return row ? readProfile(row) : null;
}

export function listAgentProfiles(
  limit = 100,
  offset = 0
): { profiles: AgentProfile[]; total: number } {
  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT * FROM agent_profiles WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as ProfileRow[];
  const count = db
    .prepare("SELECT COUNT(*) AS total FROM agent_profiles WHERE deleted_at IS NULL")
    .get() as { total: number };
  return { profiles: rows.map(readProfile), total: count.total };
}

export function listRoutingAgentProfiles(): AgentProfile[] {
  return (
    getDbInstance().prepare("SELECT * FROM agent_profiles ORDER BY id").all() as ProfileRow[]
  ).map(readProfile);
}

/** One authoritative ownership snapshot per graph, including permanent tombstones. */
export function getAgentProfileAliases(): Set<string> {
  const rows = getDbInstance().prepare("SELECT alias FROM agent_profile_aliases").all() as Array<{
    alias: string;
  }>;
  return new Set(rows.map((row) => row.alias.toLowerCase()));
}

function requireTarget(db: ReturnType<typeof getDbInstance>, id: string): void {
  if (!db.prepare("SELECT id FROM combos WHERE id = ?").get(id)) {
    throw new AgentProfileError("invalid-target");
  }
}

/** All writes inside these transactions are synchronous, including alias reservations. */
export function createAgentProfile(input: unknown): AgentProfile {
  const definition = agentDefinitionSchema.parse(input);
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    requireTarget(db, definition.targetComboId);
    db.prepare(
      "INSERT INTO agent_profiles(id, slug, data, combo_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      definition.slug,
      JSON.stringify(definition),
      definition.targetComboId,
      definition.enabled ? 1 : 0,
      now,
      now
    );
    const insert = db.prepare("INSERT INTO agent_profile_aliases(alias, profile_id) VALUES (?, ?)");
    for (const alias of [
      `agent/${definition.slug}`,
      `combo/agent/${definition.slug}`,
      id,
      `combo/${id}`,
    ]) {
      insert.run(alias, id);
    }
  })();
  return getAgentProfile(id)!;
}

export function updateAgentProfile(id: string, revision: number, input: unknown): AgentProfile {
  const definition: AgentDefinition = agentDefinitionSchema.parse(input);
  const db = getDbInstance();
  db.transaction(() => {
    const existing = getAgentProfile(id);
    if (!existing || existing.deletedAt) throw new AgentProfileError("not-found");
    if (existing.slug !== definition.slug) throw new AgentProfileError("immutable-slug");
    if (existing.revision !== revision) throw new AgentProfileError("conflict");
    requireTarget(db, definition.targetComboId);
    const result = db
      .prepare(
        "UPDATE agent_profiles SET data = ?, combo_id = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL"
      )
      .run(
        JSON.stringify(definition),
        definition.targetComboId,
        definition.enabled ? 1 : 0,
        new Date().toISOString(),
        id,
        revision
      );
    if (result.changes !== 1) throw new AgentProfileError("conflict");
  })();
  return getAgentProfile(id)!;
}

export function deleteAgentProfile(id: string, revision: number): void {
  const now = new Date().toISOString();
  const result = getDbInstance()
    .prepare(
      "UPDATE agent_profiles SET enabled = 0, deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL"
    )
    .run(now, now, id, revision);
  if (result.changes !== 1) {
    throw new AgentProfileError(getAgentProfile(id) ? "conflict" : "not-found");
  }
}

/** Batch imports reserve all aliases atomically or leave the database unchanged. */
export function importAgentProfiles(inputs: unknown[]): AgentProfile[] {
  const definitions = inputs.map((input) => agentDefinitionSchema.parse(input));
  return getDbInstance().transaction(() => definitions.map(createAgentProfile))();
}
