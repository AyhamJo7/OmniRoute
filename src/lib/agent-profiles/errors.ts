export type AgentProfileErrorCode = "not-found" | "conflict" | "invalid-target" | "immutable-slug";

export class AgentProfileError extends Error {
  constructor(public readonly code: AgentProfileErrorCode) {
    super(code);
    this.name = "AgentProfileError";
  }
}
