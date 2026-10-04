import { handleAgentManagement } from "@/lib/agent-profiles/management";

interface RouteContext {
  params: Promise<{ id: string }>;
}
export async function GET(request: Request, context: RouteContext) {
  return handleAgentManagement(request, "get", (await context.params).id);
}
export async function PUT(request: Request, context: RouteContext) {
  return handleAgentManagement(request, "update", (await context.params).id);
}
export async function DELETE(request: Request, context: RouteContext) {
  return handleAgentManagement(request, "delete", (await context.params).id);
}
