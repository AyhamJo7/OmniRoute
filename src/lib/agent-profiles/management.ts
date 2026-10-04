import { getAgentModelLimits } from "./model-capabilities";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
  importAgentProfiles,
} from "@/lib/db/agentProfiles";
import * as log from "@/sse/utils/logger";
import { areAgentProfilesEnabled } from "./feature-flag";
import { AgentProfileError } from "./errors";
import { exportAgentProfiles } from "./exports";
import {
  agentDefinitionSchema,
  agentExportQuerySchema,
  agentIdSchema,
  agentListQuerySchema,
  agentRevisionSchema,
  MAX_PROFILE_PAGE_SIZE,
} from "./schema";
import { AGENT_TEMPLATES } from "./templates";

const updateSchema = z
  .object({ revision: agentRevisionSchema, profile: agentDefinitionSchema })
  .strict();
const deleteSchema = z.object({ revision: agentRevisionSchema }).strict();
const importSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(agentDefinitionSchema).min(1).max(MAX_PROFILE_PAGE_SIZE),
  })
  .strict();
const exportSchema = agentExportQuerySchema.extend({
  baseUrl: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    })
    .optional(),
});
const MAX_BODY_BYTES = 1_048_576;
interface RequestFault {
  status: number;
}
function requestFault(status: number): RequestFault {
  return { status };
}

async function body(request: Request): Promise<unknown> {
  if (!request.body) throw requestFault(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw requestFault(413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw requestFault(400);
  }
}

function failure(error: unknown): Response {
  if (error instanceof z.ZodError)
    return createErrorResponse({ status: 400, message: "Invalid agent profile input" });
  if (error instanceof AgentProfileError) {
    const status = error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400;
    return createErrorResponse({ status, message: `Agent profile ${error.code}` });
  }
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    [400, 413].includes(Number(error.status))
  ) {
    return createErrorResponse({ status: Number(error.status), message: "Invalid request body" });
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    String(error.code).startsWith("SQLITE_CONSTRAINT")
  ) {
    return createErrorResponse({
      status: 409,
      message: "Agent profile conflicts with an existing record",
    });
  }
  log.error("AGENT_PROFILES", "Management operation failed");
  return createErrorResponse({ status: 500, message: "Agent profile operation failed" });
}

export async function handleAgentManagement(
  request: Request,
  action: "list" | "create" | "get" | "update" | "delete" | "export" | "import" | "templates",
  id?: string
): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  if (!areAgentProfilesEnabled()) return createErrorResponse({ status: 404, message: "Not found" });
  try {
    if (action === "list") {
      const query = new URL(request.url).searchParams;
      const range = agentListQuerySchema.parse(Object.fromEntries(query));
      return Response.json(listAgentProfiles(range.limit, range.offset));
    }
    if (action === "create")
      return Response.json(createAgentProfile(agentDefinitionSchema.parse(await body(request))), {
        status: 201,
      });
    if (action === "templates") return Response.json({ templates: AGENT_TEMPLATES });
    if (action === "import") {
      const input = importSchema.parse(await body(request));
      const imported = importAgentProfiles(input.profiles);
      return Response.json({ profiles: imported }, { status: 201 });
    }
    if (action === "export") {
      const input = exportSchema.parse(await body(request));
      const selected = input.ids
        ? input.ids.map((selectedId) => {
            const profile = getAgentProfile(selectedId);
            if (!profile || profile.deletedAt) throw new AgentProfileError("not-found");
            return profile;
          })
        : listAgentProfiles(MAX_PROFILE_PAGE_SIZE).profiles;
      return Response.json(
        {
          files: exportAgentProfiles(
            selected,
            input.format,
            input.baseUrl,
            input.format === "opencode" ? await getAgentModelLimits(selected) : undefined
          ),
        },
        { headers: { "cache-control": "no-store" } }
      );
    }
    const profileId = agentIdSchema.parse(id);
    if (action === "get") {
      const profile = getAgentProfile(profileId);
      if (!profile || profile.deletedAt) throw new AgentProfileError("not-found");
      return Response.json(profile);
    }
    if (action === "update") {
      const input = updateSchema.parse(await body(request));
      return Response.json(updateAgentProfile(profileId, input.revision, input.profile));
    }
    const input = deleteSchema.parse(await body(request));
    deleteAgentProfile(profileId, input.revision);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
