import type { ComboLike } from "@omniroute/open-sse/services/combo/types";
import type { AgentProfile } from "./schema";

const PROFILE_OWNER = Symbol("agent-profile-owner");
export interface AgentProjectionOwner {
  id: string;
  revision: number;
  targetComboId: string | null;
}

export function getAgentProjectionOwner(combo: ComboLike): AgentProjectionOwner | null {
  return (combo as ComboLike & { [PROFILE_OWNER]?: AgentProjectionOwner })[PROFILE_OWNER] ?? null;
}

/** Pure projection: no credentials, persisted combo mutation or strategy implementation. */
export function compileAgentProfile(profile: AgentProfile, targetName: string | null): ComboLike {
  const projection: ComboLike & { [PROFILE_OWNER]: AgentProjectionOwner } = {
    id: profile.id,
    name: `agent/${profile.slug}`,
    strategy: "priority",
    isHidden: true,
    models: [{ kind: "combo-ref", comboName: targetName ?? "", id: "target", weight: 0 }],
    config: { nestedComboMode: "execute", maxRetries: 0 },
    [PROFILE_OWNER]: {
      id: profile.id,
      revision: profile.revision,
      targetComboId: profile.targetComboId,
    },
  };
  return projection;
}
