// Match the existing client config generator's documented unknown-model defaults.
export const DEFAULT_CLIENT_CONTEXT_TOKENS = 128_000;
export const DEFAULT_CLIENT_OUTPUT_TOKENS = 8_192;
export interface AgentModelLimits {
  context: number;
  output: number;
}
