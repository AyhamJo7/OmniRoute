---
title: "Agent Profiles"
version: 3.8.51
lastUpdated: 2026-10-03
---

# Agent Profiles

An agent is a named role backed by an existing combo. The combo chooses models,
accounts, routing strategy and failover; the profile adds instructions and client
permissions. The client runs tools. Profiles do not start processes or execute git
commands on the gateway.

## Enable and create

Enable `AGENT_PROFILES_ENABLED` in Settings → Feature Flags, or set
`AGENT_PROFILES_ENABLED=true` before starting the gateway. The database flag override
wins over the environment. The feature defaults to off.

Open **Agents** in the sidebar. Choose a role template, enter a name and immutable
slug, select a combo, and save. Model-chain details appear below the combo selector.
Use the **Combos** link to configure model choices, account pins, retry limits,
context options and routing strategy. Profiles reference the combo's ID, so renaming
it works. Deleting it disables dispatch; recreating its old name does not retarget
the agent. Edit the profile to choose another combo explicitly.

Suggested mappings for a subscription-first setup:

| Role        | Existing combo example | Client responsibility                                            |
| ----------- | ---------------------- | ---------------------------------------------------------------- |
| Planner     | `opus-plan`            | Inspect requirements and produce an acceptance plan              |
| Implementer | `sonnet-work`          | Edit the workspace and report checks                             |
| Reviewer    | `review-codex`         | Review the diff; verify the actual fallback model's independence |
| Fixer       | `sonnet-work`          | Reproduce and repair findings                                    |
| Git         | `fast-small`           | Prepare commit/PR text for parent-client approval                |
| Researcher  | `bulk-work`            | Gather evidence and references                                   |
| Custom      | Any existing combo     | Follow your own role instructions                                |

These are examples, not automatically created routing policies. Configure subscription
connections and quota-based fallback in Combos first. A role name never changes
billing, makes a reseller model use a subscription, or guarantees review independence.

## Instructions and permissions

- **Client**: exports carry the role instructions; the gateway preserves native client
  prompts without injecting the role again. This is the default.
- **Server**: the gateway adds role instructions alongside native prompts; exports
  contain client boundary instructions.
- **Both**: both locations carry the instructions. Existing matching role text is
  deduplicated where the protocol supports system instructions.

The optional tools field is a comma-separated list of **literal incoming tool names**,
for example `Read, Grep, Glob`. Blank permits the client's incoming tools; an empty
array through the API permits none. A forced excluded tool is rejected. This gateway
filter does not grant client permissions. Tags are optional and do not affect routing.

Claude Code read-only exports allow Read/Grep/Glob. Workspace exports also allow
Edit/Write. OpenCode uses read permissions and asks before workspace edits. Shell,
recursive task delegation and automatic git actions are not enabled by these exports.
Approval profiles prepare proposals for the parent client's approval flow. Git profiles
stay read-only even if configured with workspace access. The parent client runs tests
and approved commands under its own workspace rules.

Native Anthropic cache markers are retained. Profiles add no cache marker; requests
with more than four markers are rejected before provider dispatch. This does not repair
unrelated planner/executor or client compaction defects.
The admission check counts protocol markers, including a top-level automatic cache
slot, rather than similarly named fields inside tool inputs or schemas. See the
[provider's prompt-cache limits](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Export, import and use

Select Claude Code, OpenCode or JSON in the export panel. Review each file and download
it. Install Claude Code files at the displayed `.claude/agents/<slug>.md` path in your
project. Configure your Claude Code launcher with `ANTHROPIC_BASE_URL` pointing to the
gateway **without `/v1`**, and your existing gateway authentication environment. The
exported model is `agent/<slug>`; it does not need to appear in `/v1/models`.

Merge the OpenCode export into your project's `opencode.json`. It declares the hidden
models locally under the `omniroute` provider and uses `OMNIROUTE_API_KEY` via an
environment reference. Set that variable yourself; exports never contain saved provider
credentials. Keep the gateway URL credential-free. Do not overwrite other project
providers or permission rules when merging.

JSON import accepts `{ "version": 1, "profiles": [...] }`. Combo IDs must exist on the
receiving installation. Imports create new profiles atomically and reject collisions;
they do not overwrite existing definitions. Change a slug when cloning. Deleted slugs
and IDs remain reserved to prevent old model aliases becoming ordinary provider routes.
Orphaned definitions need a valid target ID before they can be imported.
Management requests are limited to 1 MiB. Split large imports into smaller batches;
export selected profiles when a complete collection exceeds that limit.

## API and dispatch

Management endpoints require the same authentication as Combos:

| Endpoint                                 | Method             | Purpose                                |
| ---------------------------------------- | ------------------ | -------------------------------------- |
| `/api/agent-profiles?limit=100&offset=0` | GET                | Profiles and total count               |
| `/api/agent-profiles`                    | POST               | Create a validated definition          |
| `/api/agent-profiles/<id>`               | GET / PUT / DELETE | Read, replace or soft-delete           |
| `/api/agent-profiles/templates`          | GET                | Role instruction templates             |
| `/api/agent-profiles/export`             | POST               | `{format, ids?, baseUrl?}` → file data |
| `/api/agent-profiles/import`             | POST               | Atomic versioned import                |

PUT requires `{ "revision": <current>, "profile": <full definition> }`; DELETE requires
`{ "revision": <current> }`. Stale revisions return 409. Lists and export selections are
bounded to 200 profiles; export the displayed page or supply explicit IDs.

Inference uses the existing chat, Messages, Responses and Gemini generation routes.
Owned UUID, case-insensitive, `combo/` and context-window aliases resolve to the same
profile. Media and direct provider transports reject owned aliases. A nested profile
requires `nestedComboMode: "execute"` on every ancestor; flattening would erase role
boundaries and is rejected.

Restricted keys must allow both `agent/<slug>` and the target combo name. Exact rules
containing `/` remain exact; `agent/*` is not a glob. `combo/*` retains its existing
all-combos meaning. Existing connection, model, quota and budget checks still apply.
Agent exhaustion does not invoke the unrelated global fallback model.

Disablement applies to new attempts, including retries already admitted. An already
admitted response stream may finish. Profile or combo changes during a retry reject
stale work; even an unrelated combo edit can conservatively invalidate that attempt.
Use the existing combo trace and usage views to identify the model actually selected.

## Client workflows

Have the parent client retain the original task, plan, diff and command evidence between
roles. Ask it to plan, implement, review, fix at most a declared number of times, then
prepare git actions for approval. The parent runs tests and decides whether findings are
resolved; reviewer prose cannot turn failing commands into a pass.

See [workflow feasibility](../frameworks/AGENT_PROFILES_WORKFLOWS.md) for the boundaries
of the existing two-model planner/executor path and the five-role workflow.
