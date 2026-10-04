import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

export const AGENT_PROFILES_FLAG = "AGENT_PROFILES_ENABLED";

export function areAgentProfilesEnabled(): boolean {
  try {
    return isFeatureFlagEnabled(AGENT_PROFILES_FLAG);
  } catch {
    // Eligibility must fail closed if the flag store is unavailable.
    return false;
  }
}
