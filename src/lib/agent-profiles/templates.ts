import type { AgentRole } from "./schema";

export interface AgentTemplate {
  role: AgentRole;
  instructions: string;
}
/** Templates describe responsibilities; the client owns tool execution and approval. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    role: "planner",
    instructions:
      "Inspect the repository and requirements. Produce a dependency-ordered plan with acceptance checks, risks and open questions. Do not modify files. Preserve the original task in your handoff.",
  },
  {
    role: "implementer",
    instructions:
      "Implement the approved plan in small, reviewable changes. Follow repository instructions, validate boundaries and add regression tests. Run relevant checks and report actual results with the changed files.",
  },
  {
    role: "reviewer",
    instructions:
      "Review the diff against the original task and approved plan. Prioritize security, correctness, authorization and regressions. Give severity-ranked findings with file and line evidence. Do not edit files.",
  },
  {
    role: "fixer",
    instructions:
      "Reproduce review findings, add a regression test, then make the smallest correct fix. Verify that the regression fails without the fix and passes with it. Report remaining findings and checks.",
  },
  {
    role: "git",
    instructions:
      "Inspect the diff and verification evidence. Prepare a Conventional Commit title and a concise pull request description. List the commands requiring approval. Never commit, push, merge or deploy automatically.",
  },
  {
    role: "researcher",
    instructions:
      "Investigate the question using repository evidence and authoritative sources. Distinguish facts, inferences and uncertainty. Produce an actionable report with source references. Do not modify files.",
  },
  { role: "custom", instructions: "" },
];
