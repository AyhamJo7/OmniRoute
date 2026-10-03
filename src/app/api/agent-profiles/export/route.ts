import { handleAgentManagement } from "@/lib/agent-profiles/management";

export async function POST(request: Request) {
  return handleAgentManagement(request, "export");
}
