import type { ComboLike, HandleComboChatOptions } from "@omniroute/open-sse/services/combo/types";
import { getAgentProfile, getAgentProfileAliases } from "@/lib/db/agentProfiles";
import { stripContextWindowSuffix } from "@omniroute/open-sse/services/model";
import { getComboById } from "@/lib/db/combos";
import { getCombosCacheVersion } from "@/lib/db/readCache";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { getAgentProjectionOwner } from "./compiler";
import { areAgentProfilesEnabled } from "./feature-flag";
import {
  prepareAgentRequestBody,
  hasForbiddenAgentToolChoice,
  exceedsAgentCacheBoundaries,
} from "./request-body";
import type { AgentProfile } from "./schema";

interface ProfileGraph {
  projections: ComboLike[];
  error: Response | null;
}
function denial(status: number, code: string): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(status, "Agent profile is unavailable for this request", undefined, { code })
    ),
    {
      status,
      headers: { "content-type": "application/json", "x-omniroute-agent-denied": "1" },
    }
  );
}
function collection(options: HandleComboChatOptions): ComboLike[] {
  const values = Array.isArray(options.allCombos)
    ? options.allCombos
    : (options.allCombos?.combos ?? []);
  return values as ComboLike[];
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function profileGraph(options: HandleComboChatOptions): ProfileGraph {
  const all = collection(options);
  const byName = new Map(all.map((combo) => [combo.name, combo]));
  const aliases = getAgentProfileAliases();
  const isOwned = (name: string) =>
    aliases.has(name.toLowerCase()) ||
    aliases.has((stripContextWindowSuffix(name) || name).toLowerCase());
  const projections: ComboLike[] = [];
  let error: Response | null = null;
  const visited = new Set<string>();
  function visit(combo: ComboLike, ancestors: ComboLike[]): void {
    if (ancestors.some((ancestor) => ancestor.name === combo.name)) {
      if (projections.length > 0 || isOwned(combo.name)) {
        error = denial(400, "AGENT_CYCLE");
      }
      return;
    }
    // A second path with different execution semantics must be checked separately.
    const visitKey = `${combo.name}:${ancestors.some((parent) => parent.config?.nestedComboMode !== "execute")}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const owner = getAgentProjectionOwner(combo);
    if (owner) {
      projections.push(combo);
      if (ancestors.some((parent) => parent.config?.nestedComboMode !== "execute")) {
        error = denial(400, "AGENT_FLATTEN_UNSUPPORTED");
      }
    } else if (isOwned(combo.name)) {
      error = denial(404, "AGENT_OWNERSHIP_REQUIRED");
    }
    for (const step of combo.models ?? []) {
      const value = object(step);
      const name = typeof step === "string" ? step : (value?.comboName ?? value?.model);
      if (typeof name !== "string") continue;
      const nested = byName.get(name);
      const registered = isOwned(name);
      if (registered && (!nested || value?.kind === "model")) {
        error = denial(400, "AGENT_REFERENCE_UNSUPPORTED");
      }
      if (nested) visit(nested, [...ancestors, combo]);
    }
  }
  visit(options.combo, []);
  return { projections, error };
}

/** Used at the HTTP fallback boundary; ownership is authoritative, not a prefix test. */
export function comboGraphContainsAgentProfile(
  options: Pick<HandleComboChatOptions, "combo" | "allCombos">
): boolean {
  const graph = profileGraph(options as HandleComboChatOptions);
  return graph.projections.length > 0 || graph.error !== null;
}

export async function prepareAgentDispatch(options: HandleComboChatOptions): Promise<{
  options: HandleComboChatOptions;
  rejection: Response | null;
  recheck: () => Promise<Response | null>;
}> {
  const graph = profileGraph(options);
  const cacheVersion = getCombosCacheVersion();
  let dispatchRejection: Response | null = null;
  const allowed = options.apiKeyAllowedCombos;
  async function eligible(projection: ComboLike): Promise<AgentProfile | Response> {
    const owner = getAgentProjectionOwner(projection)!;
    const profile = getAgentProfile(owner.id);
    if (
      !areAgentProfilesEnabled() ||
      !profile ||
      profile.deletedAt ||
      !profile.enabled ||
      !profile.targetComboId
    ) {
      return denial(404, "AGENT_DISABLED");
    }
    if (profile.revision !== owner.revision || profile.targetComboId !== owner.targetComboId) {
      return denial(409, "AGENT_REVISION_CHANGED");
    }
    const target = await getComboById(profile.targetComboId);
    if (!target) return denial(404, "AGENT_TARGET_MISSING");
    const snapshot = collection(options).find((combo) => combo.id === profile.targetComboId);
    if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(target)) {
      return denial(409, "AGENT_TARGET_CHANGED");
    }
    if (Array.isArray(allowed)) {
      const permits = (name: string) =>
        allowed.some((rule) => rule === "combo/*" || rule === name || rule === `combo/${name}`);
      if (!permits(projection.name) || !permits(String(target.name)))
        return denial(403, "AGENT_COMBO_FORBIDDEN");
    }
    return profile;
  }
  async function recheck(): Promise<Response | null> {
    if (graph.error) return graph.error;
    if (graph.projections.length === 0) return null;
    if (getCombosCacheVersion() !== cacheVersion) return denial(409, "AGENT_TARGET_CHANGED");
    for (const projection of graph.projections) {
      const verdict = await eligible(projection);
      if (verdict instanceof Response) return verdict;
    }
    return dispatchRejection;
  }
  const rejection = await recheck();
  if (rejection || graph.projections.length === 0) return { options, rejection, recheck };
  const own = getAgentProjectionOwner(options.combo);
  const wrapped: HandleComboChatOptions = {
    ...options,
    handleSingleModel: async (body, model, target) => {
      const forbidden = await recheck();
      if (forbidden) return forbidden;
      if (!own) return options.handleSingleModel(body, model, target);
      const profile = await eligible(options.combo);
      if (profile instanceof Response) return profile;
      const prepared = prepareAgentRequestBody(options.body, body, profile);
      if (hasForbiddenAgentToolChoice(prepared, profile))
        dispatchRejection = denial(400, "AGENT_TOOL_FORBIDDEN");
      else if (exceedsAgentCacheBoundaries(prepared))
        dispatchRejection = denial(400, "AGENT_CACHE_BOUNDARIES");
      if (dispatchRejection) return dispatchRejection;
      return options.handleSingleModel(prepared, model, target);
    },
  };
  return { options: wrapped, rejection: null, recheck };
}
