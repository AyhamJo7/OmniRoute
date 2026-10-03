import { getAgentProfileForAlias } from "@/lib/db/agentProfiles";
import { areAgentProfilesEnabled } from "./feature-flag";

/** Media endpoints and direct provider transports cannot execute role projections. */
export function rejectUnavailableAgentRequest(model: string | null, url: string): Response | null {
  if (!model) return null;
  const path = new URL(url).pathname;
  // Provider-scoped embeddings add their prefix before this shared policy hook.
  // Check the original alias too, before it can be mistaken for a provider model.
  const scopedModel = /\/providers\/[^/]+\/embeddings$/.test(path)
    ? model.slice(model.indexOf("/") + 1)
    : null;
  const profile =
    getAgentProfileForAlias(model) || (scopedModel ? getAgentProfileForAlias(scopedModel) : null);
  if (!profile) return null;
  const supported =
    /\/(?:chat\/completions|messages|responses)$/.test(path) ||
    /\/models\/.+:(?:generateContent|streamGenerateContent)$/.test(path);
  if (
    supported &&
    areAgentProfilesEnabled() &&
    profile.enabled &&
    !profile.deletedAt &&
    profile.targetComboId
  ) {
    return null;
  }
  return Response.json(
    {
      error: {
        message: "Agent profile is unavailable for this request",
        type: "invalid_request_error",
        code: "AGENT_UNAVAILABLE",
      },
    },
    { status: 404, headers: { "x-omniroute-agent-denied": "1" } }
  );
}
