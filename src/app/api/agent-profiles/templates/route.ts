import { handleAgentManagement } from "@/lib/agent-profiles/management";

export async function GET(request: Request) {
  return handleAgentManagement(request, "templates");
}
