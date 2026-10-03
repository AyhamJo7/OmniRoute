import { z } from "zod";

export const AGENT_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "fixer",
  "git",
  "researcher",
  "custom",
] as const;
export const MAX_INSTRUCTION_LENGTH = 20_000;
export const MAX_PROFILE_PAGE_SIZE = 200;
export const agentSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const toolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const targetIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);

export const agentDefinitionFieldsSchema = z
  .object({
    slug: agentSlugSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(2_000).default(""),
    role: z.enum(AGENT_ROLES).default("custom"),
    instructions: z.string().trim().max(MAX_INSTRUCTION_LENGTH).default(""),
    targetComboId: targetIdSchema,
    enabled: z.boolean().default(true),
    injection: z.enum(["client", "server", "both"]).default("client"),
    clientAccess: z.enum(["read-only", "workspace", "approval"]).optional(),
    toolAllowlist: z.array(toolNameSchema).max(100).nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .strict();

export const agentDefinitionSchema = agentDefinitionFieldsSchema.transform((value) => ({
  ...value,
  clientAccess:
    value.clientAccess ??
    (value.role === "implementer" || value.role === "fixer" ? "workspace" : "read-only"),
  toolAllowlist: value.toolAllowlist === null ? null : [...new Set(value.toolAllowlist)],
  tags: [...new Set(value.tags)],
}));

export type AgentDefinition = z.output<typeof agentDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;
export type AgentRole = (typeof AGENT_ROLES)[number];
export interface AgentProfile extends Omit<AgentDefinition, "targetComboId"> {
  targetComboId: string | null;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export const agentRevisionSchema = z.number().int().positive();
export const agentIdSchema = z.string().uuid();
export const agentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PROFILE_PAGE_SIZE).default(100),
    offset: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
export const agentExportQuerySchema = z
  .object({
    format: z.enum(["claude-code", "opencode", "json"]),
    ids: z.array(agentIdSchema).min(1).max(MAX_PROFILE_PAGE_SIZE).optional(),
  })
  .strict();

export const agentProfileResponseSchema = agentDefinitionFieldsSchema.extend({
  targetComboId: targetIdSchema.nullable(),
  clientAccess: z.enum(["read-only", "workspace", "approval"]),
  id: agentIdSchema,
  revision: agentRevisionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
