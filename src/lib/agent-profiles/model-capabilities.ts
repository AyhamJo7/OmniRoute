import { getCombos } from "@/lib/db/combos";
import { computeComboContextLength } from "@/lib/combos/comboContext";
import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import { buildAliasMaps, getComboTargetModelId } from "@/app/api/v1/models/catalogProviderMaps";
import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo";
import type { AgentProfile } from "./schema";

import {
  DEFAULT_CLIENT_CONTEXT_TOKENS,
  DEFAULT_CLIENT_OUTPUT_TOKENS,
  type AgentModelLimits,
} from "./model-limits";

/** Derive client limits from the same metadata and nested targets as the combo catalog. */
export async function getAgentModelLimits(
  profiles: AgentProfile[]
): Promise<Record<string, AgentModelLimits>> {
  const combos = (await getCombos()).flatMap((combo) =>
    typeof combo.id === "string" && typeof combo.name === "string" && Array.isArray(combo.models)
      ? [{ ...combo, id: combo.id, name: combo.name, models: combo.models as unknown[] }]
      : []
  );
  const aliases = buildAliasMaps();
  const result: Record<string, AgentModelLimits> = {};
  for (const profile of profiles) {
    const combo = combos.find((candidate) => candidate.id === profile.targetComboId);
    if (!combo) continue;
    const context = computeComboContextLength(combo, combos) ?? DEFAULT_CLIENT_CONTEXT_TOKENS;
    const outputs = resolveNestedComboTargets(combo, combos).flatMap((target) => {
      const resolved = getComboTargetModelId(aliases, target);
      if (!resolved) return [];
      const metadata = getCanonicalModelMetadata({
        provider: resolved.providerId,
        model: resolved.modelId,
      });
      const source = metadata?.metadata.source;
      if (!source?.providerRegistry && !source?.staticSpec && !source?.syncedCapability) return [];
      const output = metadata?.limits.maxOutputTokens;
      return typeof output === "number" && Number.isFinite(output) && output > 0 ? [output] : [];
    });
    result[profile.id] = {
      context,
      output: Math.min(
        context,
        outputs.length > 0 ? Math.min(...outputs) : DEFAULT_CLIENT_OUTPUT_TOKENS
      ),
    };
  }
  return result;
}
