---
title: "Agent Profile Workflows and Feasibility"
version: 3.8.51
lastUpdated: 2026-10-03
---

# Agent Profile Workflows and Feasibility

[Agent Profiles](../routing/AGENT_PROFILES.md) supply role instructions, existing combo
routing and client configuration exports. A profile is not a task scheduler. This
bounded feasibility investigation recommends client orchestration for five roles.

## Existing mechanisms

The wiring below was inspected in source. Local fixtures establish the narrower
behaviors stated in the evidence column; they do not establish external-service
availability or production throughput.

| Mechanism           | Existing call path and responsibility                                                                            | Evidence and boundary                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plain pipeline      | Combo dispatch → `open-sse/services/combo/dispatchPrelude.ts`; sequential step prompts                           | Existing pipeline tests cover dispatch. Later text steps can lose the original request. This feature preserves existing semantics.                     |
| Planner/executor    | Pipeline dispatch → `open-sse/services/agenticPipeline.ts` when `agenticOrchestration.enabled` is set            | Exactly two models. A local real-client tool loop passed; the client executes tools and resends history.                                               |
| Smart Auto-Pipeline | Auto target resolution → `open-sse/services/autoCombo/pipelineRouter.ts`, for `auto/smart` or `pipeline_enabled` | Existing plan/execute/reflect/fix routing. Profiles add no strategy or activation. No production workflow was exercised.                               |
| Cloud Agents        | `src/lib/cloudAgent/api.ts` and provider implementations expose remote task jobs                                 | External provider credentials, service limits and task execution are separate from combo subscription routing. Source inspected; remote jobs untested. |
| ACP                 | `/api/acp/agents` → `src/lib/acp/registry.ts` and `manager.ts`                                                   | Existing installed-CLI discovery and process transport. Profile creation does not launch a CLI or grant subprocess permission. Source inspected.       |
| A2A                 | `/api/a2a/tasks` → task execution and six skills; smart-routing skill calls `/v1/chat/completions`               | Structured task interface, not a general coding tool client. Source inspected; authenticated external task lifecycle untested.                         |
| Conductor           | `/api/conductor/*` proxies; `src/lib/conductor/boot.ts` starts an opt-in external-hub bridge                     | Separate hub owns orchestration; gateway mirrors events and persists its cursor. Source inspected; external hub untested.                              |

## Two-role experiment

An exported read-only profile was loaded into the installed Claude Code client. The
client requested its real Read tool against a temporary fixture. The fork routed
requests through its existing planner/executor combo to isolated local upstreams.
No subscription credential or paid inference was used.

The observed sequence was planner → executor → planner → planner: two upstream calls
for tool selection and two for the tool-result continuation/final answer. Both
continuation requests carried actual fixture evidence, and every call retained the
original task. All four requests had three native cache boundaries. The gateway did
not execute the tool.

A separate normal-client run discovered the exported `.claude/agents` file directly
in an isolated project and executed the real Read tool. Its four requests retained
the original task and actual tool-result evidence, with two cache boundaries each.
This one-run check is separate from the twenty-run measurement below.

The pinned OpenCode client accepted the exported configuration and started. A direct
CLI subagent selection fell back to the default primary agent; the attempted Read was
denied. This does not validate an OpenCode role tool loop. The exports declare
subagents for parent-client delegation, and the parent's model must also be selected
explicitly through the gateway. Native OpenCode inference remains unverified.

Twenty consecutive real-client fixture loops passed. End-to-end p50 was 1.644 seconds
and p95 was 1.714 seconds, with four upstream calls each. This includes local client
startup and loopback stubs on the development host; it is not a production latency
or throughput promise. Repeated context transfer occurs at every planner/executor
handoff; the client must retain the transcript.

Deterministic tests also cover denied/error tool evidence, the completed-round bound,
missing planner markers, malformed continuation, no-tools mode, provider failure
before output, caller cancellation, duplicate submission and loss of transcript
after restart. Duplicate requests can produce another tool proposal; transcript loss
resets the inferred round count. These are not durable exactly-once guarantees.

The historical five-cache-block failure and `continuation=false` report remain
unresolved hypotheses: standard native fixtures did not reproduce them. Profile
dispatch rejects more than four native cache boundaries before provider calls;
this does not repair unrelated pipeline or client compaction bugs.

Synthetic upstream usage is 100 input and 20 output tokens per call, or 400/80 per
four-call fixture loop. This is declared fixture data, not tokenizer measurement.
Actual provider billing was zero; production token cost, latency, context-transfer
size and fallback performance require separately approved provider experiments.
Trace identity identifies the selected local fixture model, not an independent
production reviewer.

## Five-role client workflow

1. **Planner:** retain the original request, scope, acceptance criteria and assumptions
   in a workspace plan. Read-only access is sufficient.
2. **Implementer:** use a workspace profile to edit files. The parent client runs
   required commands and records exit codes, revision and artifacts.
3. **Reviewer:** inspect the actual diff, plan and command evidence with read-only
   access. Check trace identity; a different role label does not prove a different
   model or provider after failover.
4. **Fixer:** repair reproducible findings, rerun affected checks and return to review
   only within a declared round/cost limit. Failing commands remain failures.
5. **Git:** prepare commit and pull-request text. The parent obtains the operator's
   approval before git publication, merge or deployment.

The parent client owns durable state, artifact paths, command execution and recovery.
Persist a task ID, revision, current role, completed actions, findings, budget, fix
round count and pending approval. On restart, inspect the workspace and reconcile
already-started actions before resubmitting them. Cancellation stops new work; it
cannot undo completed filesystem or remote operations. Model failover must not replay
a side effect without reconciliation.

Exports intentionally grant no unrestricted shell or recursive task delegation.
The parent retains its established workspace permission rules and executes approved
tests/actions itself. Review prose cannot authorize a budget, override a denied tool
or turn a failed gate into a pass.

## Recommendation

**Go:** ship profiles and client exports; use a client-owned five-role workflow.
**Experimental:** the existing two-model path can delegate bounded tools through a
client, subject to the measured limits and unresolved historical defects.
**No-go:** ship a new server-side multi-role crew in this feature. Durable artifacts,
approval, budgets, cancellation, idempotency and side-effect reconciliation need an
explicit design and separate verification. Evaluate an existing client workflow or
the external Conductor hub before introducing another scheduler.

Disable `AGENT_PROFILES_ENABLED` to stop new profile attempts. An admitted stream can
finish; the flag is not a task rollback mechanism. Existing ordinary combos and
orchestration paths keep their established configuration.
