// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { agentDefinitionSchema } from "../../src/lib/agent-profiles/schema";
import { AgentProfilesConsole } from "../../src/app/(dashboard)/dashboard/agent-profiles/AgentProfilesConsole";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const profile = {
  ...agentDefinitionSchema.parse({
    slug: "reviewer",
    name: "Reviewer",
    targetComboId: "work",
    role: "reviewer",
    instructions: "Inspect evidence",
  }),
  id: "00000000-0000-4000-8000-000000000001",
  revision: 3,
  createdAt: "now",
  updatedAt: "now",
  deletedAt: null,
};
let requests: Array<{ url: string; init?: RequestInit }>;
let failUpdate: boolean;
beforeEach(() => {
  requests = [];
  failUpdate = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("/api/combos"))
        return Response.json({
          combos: [
            {
              id: "work",
              name: "subscription-first",
              strategy: "priority",
              models: ["claude/subscription", "codex/subscription", "mock/free"],
            },
          ],
          total: 1,
        });
      if (url.endsWith("/templates"))
        return Response.json({
          templates: [{ role: "reviewer", instructions: "Review security" }],
        });
      if (url.endsWith("/export"))
        return Response.json({
          files: [
            {
              path: ".claude/agents/reviewer.md",
              content: 'model: "agent/reviewer"',
              mediaType: "text/markdown",
            },
          ],
        });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "PUT" && failUpdate)
        return Response.json({ error: "conflict" }, { status: 409 });
      if (init?.method === "POST" || init?.method === "PUT")
        return Response.json(profile, { status: 201 });
      return Response.json({ profiles: [profile], total: 1 });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function loaded() {
  render(<AgentProfilesConsole />);
  await screen.findByText("Reviewer");
  await screen.findByRole("option", { name: "subscription-first" });
}

describe("agent profile management", () => {
  it("can deny all incoming tools without confusing an empty list with unrestricted tools", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "toolsGroup: none" }));
    expect(screen.getByRole("textbox", { name: "toolsGroup" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(requests.some((request) => request.init?.method === "PUT")).toBe(true)
    );
    const request = requests.find((request) => request.init?.method === "PUT");
    expect(JSON.parse(String(request?.init?.body)).profile.toolAllowlist).toEqual([]);
  });
  it("shows agent aliases and combo model chains as text, never HTML", async () => {
    await loaded();
    fireEvent.click(screen.getAllByRole("button", { name: "edit" })[0]);
    expect(screen.getByText("agent/reviewer")).toBeTruthy();
    expect(screen.getByText(/claude\/subscription/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "agent/<slug>" }).hasAttribute("disabled")).toBe(
      true
    );
  });
  it("updates with the current revision and keeps drafts on a conflict", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "Changed" },
    });
    failUpdate = true;
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByRole("alert");
    const saved = requests.find((request) => request.init?.method === "PUT");
    expect(JSON.parse(String(saved?.init?.body))).toMatchObject({
      revision: 3,
      profile: { name: "Changed", slug: "reviewer" },
    });
    expect((screen.getByRole("textbox", { name: "name" }) as HTMLInputElement).value).toBe(
      "Changed"
    );
  });
  it("requires a second action before deleting and sends an optimistic revision", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(requests.some((request) => request.init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "deleteConfirm" }));
    await waitFor(() =>
      expect(requests.some((request) => request.init?.method === "DELETE")).toBe(true)
    );
    expect(
      JSON.parse(String(requests.find((request) => request.init?.method === "DELETE")?.init?.body))
    ).toEqual({ revision: 3 });
  });
  it("clones definitions while requiring a new immutable slug", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "clone" }));
    expect((screen.getByRole("textbox", { name: "agent/<slug>" }) as HTMLInputElement).value).toBe(
      ""
    );
    expect(screen.getByRole("textbox", { name: "agent/<slug>" }).hasAttribute("disabled")).toBe(
      false
    );
    expect((screen.getByRole("textbox", { name: "name" }) as HTMLInputElement).value).toBe(
      "Reviewer (2)"
    );
  });
  it("previews exact exported files without installing them on the server", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await screen.findByText(".claude/agents/reviewer.md");
    expect(screen.getByText('model: "agent/reviewer"')).toBeTruthy();
    const sent = requests.find((request) => request.url.endsWith("/export"));
    expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
      format: "claude-code",
      ids: [profile.id],
    });
  });
});
