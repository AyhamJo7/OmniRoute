import { notFound } from "next/navigation";
import { areAgentProfilesEnabled } from "@/lib/agent-profiles/feature-flag";
import { AgentProfilesConsole } from "./AgentProfilesConsole";

export const dynamic = "force-dynamic";

export default function AgentProfilesPage() {
  if (!areAgentProfilesEnabled()) notFound();
  return <AgentProfilesConsole />;
}
