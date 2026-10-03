import type { ComboLike } from "@omniroute/open-sse/services/combo/types";
import { getComboById } from "@/lib/db/combos";
import { getAgentProfileForAlias, listRoutingAgentProfiles } from "@/lib/db/agentProfiles";
import { compileAgentProfile } from "./compiler";
import type { AgentProfile } from "./schema";

async function project(profile: AgentProfile): Promise<ComboLike> {
  const target = profile.targetComboId ? await getComboById(profile.targetComboId) : null;
  return compileAgentProfile(profile, typeof target?.name === "string" ? target.name : null);
}

/** Resolve ownership even while disabled; eligibility is enforced before dispatch. */
export async function resolveAgentProfileCombo(alias: string): Promise<ComboLike | null> {
  const profile = getAgentProfileForAlias(alias);
  return profile ? project(profile) : null;
}

export async function appendRoutingAgentProfiles(combos: ComboLike[]): Promise<ComboLike[]> {
  const profiles = listRoutingAgentProfiles();
  if (profiles.length === 0) return combos;
  const projections = await Promise.all(profiles.map(project));
  return [...combos, ...projections];
}
