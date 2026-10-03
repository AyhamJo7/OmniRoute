"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { z } from "zod";
import {
  AGENT_ROLES,
  agentDefinitionSchema,
  agentProfileResponseSchema,
  type AgentDefinitionInput,
  type AgentProfile,
  type AgentRole,
} from "@/lib/agent-profiles/schema";
import type { AgentExportFile, AgentExportFormat } from "@/lib/agent-profiles/exports";

const PAGE_SIZE = 200;
const profileListSchema = z.object({
  profiles: z.array(agentProfileResponseSchema),
  total: z.number().int().nonnegative(),
});
const combosSchema = z.object({
  combos: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      strategy: z.string().optional(),
      models: z.array(z.unknown()).default([]),
    })
  ),
});
const templatesSchema = z.object({
  templates: z.array(z.object({ role: z.enum(AGENT_ROLES), instructions: z.string() })),
});
const exportsSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string(), mediaType: z.string() })),
});
const newDefinition = (): AgentDefinitionInput => ({
  slug: "",
  name: "",
  targetComboId: "",
  role: "custom",
  instructions: "",
  description: "",
  enabled: true,
  injection: "client",
  clientAccess: "read-only",
  toolAllowlist: null,
  tags: [],
});
async function json(request: Promise<Response>): Promise<unknown> {
  const response = await request;
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
async function loadCombos(signal: AbortSignal) {
  const all: z.infer<typeof combosSchema>["combos"] = [];
  let pageOffset = 0;
  while (true) {
    const page = combosSchema.parse(
      await json(fetch(`/api/combos?limit=${PAGE_SIZE}&offset=${pageOffset}`, { signal }))
    );
    all.push(...page.combos);
    if (page.combos.length < PAGE_SIZE) return all;
    pageOffset += PAGE_SIZE;
  }
}

function definition(profile: AgentProfile): AgentDefinitionInput {
  return {
    slug: profile.slug,
    name: profile.name,
    description: profile.description,
    role: profile.role,
    instructions: profile.instructions,
    targetComboId: profile.targetComboId ?? "",
    enabled: profile.enabled,
    injection: profile.injection,
    clientAccess: profile.clientAccess,
    toolAllowlist: profile.toolAllowlist,
    tags: profile.tags,
  };
}
function download(file: AgentExportFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").pop() ?? "agent-profiles.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AgentProfilesConsole() {
  const t = useTranslations("agentProfiles");
  const c = useTranslations("common");
  const sidebar = useTranslations("sidebar");
  const cli = useTranslations("cliTools");
  const settings = useTranslations("settings");
  const api = useTranslations("apiManager");
  const usage = useTranslations("usage");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [combos, setCombos] = useState<z.infer<typeof combosSchema>["combos"]>([]);
  const [templates, setTemplates] = useState<z.infer<typeof templatesSchema>["templates"]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<AgentDefinitionInput>(newDefinition);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<AgentExportFile[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const applyProfiles = useCallback((payload: unknown) => {
    const result = profileListSchema.parse(payload);
    setProfiles(
      result.profiles.map((profile) => ({
        ...profile,
        targetComboId: profile.targetComboId ?? null,
        deletedAt: profile.deletedAt ?? null,
      }))
    );
    setTotal(result.total);
  }, []);
  const load = useCallback(
    () =>
      json(
        fetch(`/api/agent-profiles?limit=${PAGE_SIZE}&offset=${offset}`, { cache: "no-store" })
      ).then(applyProfiles),
    [offset, applyProfiles]
  );
  useEffect(() => {
    const controller = new AbortController();
    const origin = window.location.origin;
    let active = true;
    Promise.all([
      json(
        fetch(`/api/agent-profiles?limit=${PAGE_SIZE}&offset=${offset}`, {
          cache: "no-store",
          signal: controller.signal,
        })
      ).then((result) => {
        if (active) applyProfiles(result);
      }),
      loadCombos(controller.signal).then((result) => {
        if (active) setCombos(result);
      }),
      json(fetch("/api/agent-profiles/templates", { signal: controller.signal })).then((result) => {
        if (active) setTemplates(templatesSchema.parse(result).templates);
      }),
    ])
      .then(() => {
        if (active) setBaseUrl((previous) => previous || origin);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [offset, applyProfiles]);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  function change<K extends keyof AgentDefinitionInput>(key: K, value: AgentDefinitionInput[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }
  const target = combos.find((combo) => combo.id === draft.targetComboId);
  const inputClass = "w-full rounded border border-border bg-bg p-2";
  const buttonClass = "rounded border border-border px-3 py-2 disabled:opacity-50";
  function roleLabel(role: AgentRole) {
    return role === "git" ? "Git" : t(role);
  }
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{sidebar("agents")}</h1>
      <p className="text-text-muted">{t("help")}</p>
      {error && <p role="alert">{c("error")}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClass}
          disabled={busy}
          onClick={() => {
            setEditing(null);
            setDraft(newDefinition());
          }}
        >
          {c("add")}
        </button>
        <button className={buttonClass} disabled={busy} onClick={() => perform(load)}>
          {c("refresh")}
        </button>
        <Link className={buttonClass} href="/dashboard/combos">
          {sidebar("combos")}
        </Link>
      </div>
      <ul className="space-y-2" aria-label={sidebar("agents")}>
        {profiles.map((profile) => (
          <li key={profile.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>{profile.name}</strong> <code>agent/{profile.slug}</code> ·{" "}
                {roleLabel(profile.role)} ·{" "}
                {c(profile.enabled && profile.targetComboId ? "enabled" : "disabled")}
              </div>
              <div className="flex gap-2">
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => {
                    setEditing(profile);
                    setDraft(definition(profile));
                  }}
                >
                  {c("edit")}
                </button>
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => {
                    setEditing(null);
                    setDraft({ ...definition(profile), slug: "", name: `${profile.name} (2)` });
                  }}
                >
                  {usage("clone")}
                </button>
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => setDeleteId(profile.id)}
                >
                  {c("delete")}
                </button>
              </div>
            </div>
            {deleteId === profile.id && (
              <div role="group" aria-label={c("deleteConfirm")} className="mt-3 flex gap-2">
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      const response = await fetch(`/api/agent-profiles/${profile.id}`, {
                        method: "DELETE",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ revision: profile.revision }),
                      });
                      if (!response.ok) throw new Error(String(response.status));
                      setDeleteId(null);
                      if (editing?.id === profile.id) {
                        setEditing(null);
                        setDraft(newDefinition());
                      }
                      await load();
                    })
                  }
                >
                  {c("deleteConfirm")}
                </button>
                <button className={buttonClass} onClick={() => setDeleteId(null)}>
                  {c("cancel")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {total > PAGE_SIZE && (
        <div className="flex items-center gap-3">
          <button
            className={buttonClass}
            disabled={offset === 0 || busy}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ←
          </button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
          </span>
          <button
            className={buttonClass}
            disabled={offset + PAGE_SIZE >= total || busy}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            →
          </button>
        </div>
      )}
      <form
        className="space-y-4 rounded border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          perform(async () => {
            const profile = agentDefinitionSchema.parse(draft);
            await json(
              fetch(editing ? `/api/agent-profiles/${editing.id}` : "/api/agent-profiles", {
                method: editing ? "PUT" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(editing ? { revision: editing.revision, profile } : profile),
              })
            );
            setEditing(null);
            setDraft(newDefinition());
            await load();
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            {c("name")}
            <input
              className={inputClass}
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
          <label>
            <code>agent/&lt;slug&gt;</code>
            <input
              className={inputClass}
              required
              pattern="[a-z0-9][a-z0-9-]{0,62}"
              maxLength={63}
              disabled={Boolean(editing)}
              value={draft.slug}
              onChange={(event) => change("slug", event.target.value)}
            />
          </label>
          <label>
            {t("role")}
            <select
              className={inputClass}
              value={draft.role}
              onChange={(event) => {
                const role = event.target.value as AgentRole;
                change("role", role);
                change(
                  "clientAccess",
                  role === "implementer" || role === "fixer" ? "workspace" : "read-only"
                );
              }}
            >
              {AGENT_ROLES.map((role) => (
                <option value={role} key={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {sidebar("combos")}
            <select
              className={inputClass}
              required
              value={draft.targetComboId}
              onChange={(event) => change("targetComboId", event.target.value)}
            >
              <option value="">{c("none")}</option>
              {combos.map((combo) => (
                <option value={combo.id} key={combo.id}>
                  {combo.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {target && (
          <details>
            <summary>{c("models")}</summary>
            <pre className="overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify({ strategy: target.strategy, models: target.models }, null, 2)}
            </pre>
          </details>
        )}
        <label className="block">
          {c("description")}
          <input
            className={inputClass}
            maxLength={2000}
            value={draft.description}
            onChange={(event) => change("description", event.target.value)}
          />
        </label>
        <label className="block">
          {cli("instructions")}
          <textarea
            className={inputClass}
            rows={8}
            maxLength={20000}
            value={draft.instructions}
            onChange={(event) => change("instructions", event.target.value)}
          />
        </label>
        <button
          className={buttonClass}
          type="button"
          onClick={() =>
            change(
              "instructions",
              templates.find((template) => template.role === draft.role)?.instructions ?? ""
            )
          }
        >
          {usage("budgetTemplates")}
        </button>
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            {cli("instructions")}
            <select
              className={inputClass}
              value={draft.injection}
              onChange={(event) =>
                change("injection", event.target.value as AgentDefinitionInput["injection"])
              }
            >
              <option value="client">{t("client")}</option>
              <option value="server">{t("server")}</option>
              <option value="both">{settings("catalogScopeAll")}</option>
            </select>
          </label>
          <label>
            {api("permissions")}
            <select
              className={inputClass}
              value={draft.clientAccess}
              onChange={(event) =>
                change("clientAccess", event.target.value as AgentDefinitionInput["clientAccess"])
              }
            >
              <option value="read-only">{api("readOnly")}</option>
              <option value="workspace">{t("workspace")}</option>
              <option value="approval">{cli("hermesRoleApproval")}</option>
            </select>
          </label>
          <label>
            {sidebar("toolsGroup")}
            <input
              className={inputClass}
              value={draft.toolAllowlist?.join(", ") ?? ""}
              onChange={(event) =>
                change(
                  "toolAllowlist",
                  event.target.value.trim()
                    ? event.target.value
                        .split(",")
                        .map((tool) => tool.trim())
                        .filter(Boolean)
                    : null
                )
              }
            />
          </label>
          <label>
            {usage("suiteBuilderCaseTagsLabel")}
            <input
              className={inputClass}
              value={draft.tags?.join(", ") ?? ""}
              onChange={(event) =>
                change(
                  "tags",
                  event.target.value
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                )
              }
            />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => change("enabled", event.target.checked)}
          />
          {c("enabled")}
        </label>
        <div className="flex gap-2">
          <button className={buttonClass} disabled={busy} type="submit">
            {c("save")}
          </button>
          <button
            className={buttonClass}
            type="button"
            onClick={() => {
              setEditing(null);
              setDraft(newDefinition());
            }}
          >
            {c("cancel")}
          </button>
        </div>
      </form>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="text-lg font-semibold">{settings("export")}</h2>
        <label className="block">
          <code>baseURL</code>
          <input
            className={inputClass}
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {(["claude-code", "opencode", "json"] as AgentExportFormat[]).map((format) => (
            <button
              key={format}
              className={buttonClass}
              disabled={busy || profiles.length === 0}
              onClick={() =>
                perform(async () => {
                  const result = exportsSchema.parse(
                    await json(
                      fetch("/api/agent-profiles/export", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          format,
                          ids: profiles.map((profile) => profile.id),
                          baseUrl,
                        }),
                      })
                    )
                  );
                  setFiles(result.files);
                })
              }
            >
              {format === "claude-code"
                ? "Claude Code"
                : format === "opencode"
                  ? "OpenCode"
                  : "JSON"}
            </button>
          ))}
        </div>
        {files.map((file) => (
          <details key={file.path}>
            <summary>{file.path}</summary>
            <pre className="overflow-x-auto whitespace-pre-wrap">{file.content}</pre>
            <button className={buttonClass} onClick={() => download(file)}>
              {settings("export")}
            </button>
          </details>
        ))}
        <h2 className="text-lg font-semibold">{c("import")}</h2>
        <textarea
          className={inputClass}
          aria-label={c("import")}
          rows={5}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
        <button
          className={buttonClass}
          disabled={busy || !importText.trim()}
          onClick={() =>
            perform(async () => {
              await json(
                fetch("/api/agent-profiles/import", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: importText,
                })
              );
              setImportText("");
              await load();
            })
          }
        >
          {c("import")}
        </button>
      </section>
    </div>
  );
}
