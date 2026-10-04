import {
  DEFAULT_CLIENT_CONTEXT_TOKENS,
  DEFAULT_CLIENT_OUTPUT_TOKENS,
  type AgentModelLimits,
} from "./model-limits";
import { agentSlugSchema, type AgentProfile } from "./schema";

export interface AgentExportFile {
  path: string;
  content: string;
  mediaType: string;
}
export type AgentExportFormat = "claude-code" | "opencode" | "json";
const READ_TOOLS = ["Read", "Grep", "Glob"];
const WORKSPACE_TOOLS = [...READ_TOOLS, "Edit", "Write"];
const CLIENT_BOUNDARY =
  "Use the client workspace and its approval rules. Never commit, push, merge, deploy, or change permissions automatically. Report commands and their actual results; a model's opinion is not test evidence.";

function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function rolePrompt(profile: AgentProfile): string {
  return [
    CLIENT_BOUNDARY,
    profile.injection === "server"
      ? "Follow the gateway's role instructions."
      : profile.instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function claudeFile(profile: AgentProfile): AgentExportFile {
  const slug = agentSlugSchema.parse(profile.slug);
  // Git actions stay in the parent client's explicit approval flow. No Bash export.
  const tools =
    profile.clientAccess === "workspace" && profile.role !== "git" ? WORKSPACE_TOOLS : READ_TOOLS;
  const header = [
    "---",
    `name: ${yamlString(slug)}`,
    `description: ${yamlString(profile.description || profile.name)}`,
    `model: ${yamlString(`agent/${slug}`)}`,
    `tools: [${tools.map(yamlString).join(", ")}]`,
    `permissionMode: ${yamlString("default")}`,
    "---",
  ];
  return {
    path: `.claude/agents/${slug}.md`,
    content: `${header.join("\n")}\n\n${rolePrompt(profile)}\n`,
    mediaType: "text/markdown",
  };
}

function apiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid gateway base URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
  return url.toString().replace(/\/$/, "");
}

export function exportAgentProfiles(
  profiles: AgentProfile[],
  format: AgentExportFormat,
  baseUrl = "http://localhost:20128",
  limits: Record<string, AgentModelLimits> = {}
): AgentExportFile[] {
  const selected = profiles
    .filter((profile) => !profile.deletedAt)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  for (const profile of selected) agentSlugSchema.parse(profile.slug);
  if (format === "claude-code") return selected.map(claudeFile);
  if (format === "opencode") {
    const agent = Object.fromEntries(
      selected.map((profile) => {
        const writable = profile.clientAccess === "workspace" && profile.role !== "git";
        return [
          profile.slug,
          {
            description: profile.description || profile.name,
            mode: "subagent",
            model: `omniroute/agent/${profile.slug}`,
            prompt: rolePrompt(profile),
            permission: {
              "*": "deny",
              read: "allow",
              glob: "allow",
              grep: "allow",
              list: "allow",
              edit: writable ? "ask" : "deny",
              bash: "deny",
              task: "deny",
              external_directory: "deny",
            },
          },
        ];
      })
    );
    const models = Object.fromEntries(
      selected.map((profile) => [
        `agent/${profile.slug}`,
        {
          name: profile.name,
          limit: limits[profile.id] ?? {
            context: DEFAULT_CLIENT_CONTEXT_TOKENS,
            output: DEFAULT_CLIENT_OUTPUT_TOKENS,
          },
        },
      ])
    );
    const config = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        omniroute: {
          npm: "@ai-sdk/openai-compatible",
          name: "OmniRoute",
          options: { baseURL: apiBaseUrl(baseUrl), apiKey: "{env:OMNIROUTE_API_KEY}" },
          models,
        },
      },
      agent,
    };
    return [
      {
        path: "opencode.json",
        content: `${JSON.stringify(config, null, 2)}\n`,
        mediaType: "application/json",
      },
    ];
  }
  const definitions = selected.map((profile) => ({
    slug: profile.slug,
    name: profile.name,
    description: profile.description,
    role: profile.role,
    instructions: profile.instructions,
    targetComboId: profile.targetComboId,
    enabled: profile.enabled,
    injection: profile.injection,
    clientAccess: profile.clientAccess,
    toolAllowlist: profile.toolAllowlist,
    tags: profile.tags,
  }));
  return [
    {
      path: "agent-profiles.json",
      content: `${JSON.stringify({ version: 1, profiles: definitions }, null, 2)}\n`,
      mediaType: "application/json",
    },
  ];
}
