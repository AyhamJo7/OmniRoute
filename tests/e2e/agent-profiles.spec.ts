import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

test("profiles gate the real dashboard, persist a role and preview client exports", async ({
  page,
}) => {
  await gotoDashboardRoute(page, "/dashboard");
  const flagsResponse = await page.request.get("/api/settings/feature-flags");
  expect(flagsResponse.status()).toBe(200);
  const flags = (await flagsResponse.json()) as {
    flags: Array<{ key: string; source: string; effectiveValue: string }>;
  };
  const previous = flags.flags.find((flag) => flag.key === "AGENT_PROFILES_ENABLED");
  expect(previous).toBeDefined();
  const slug = `browser-${randomUUID()}`;
  let comboId: string | undefined;
  let profileId: string | undefined;
  try {
    const disabled = await page.request.put("/api/settings/feature-flags", {
      data: { key: "AGENT_PROFILES_ENABLED", value: "false" },
    });
    expect(disabled.status()).toBe(200);
    expect((await page.request.get("/api/agent-profiles")).status()).toBe(404);
    const enabled = await page.request.put("/api/settings/feature-flags", {
      data: { key: "AGENT_PROFILES_ENABLED", value: "true" },
    });
    expect(enabled.status()).toBe(200);
    const comboResponse = await page.request.post("/api/combos", {
      data: { name: slug, strategy: "priority", models: ["fixture/not-registered"] },
    });
    expect(comboResponse.status()).toBe(201);
    comboId = ((await comboResponse.json()) as { id: string }).id;

    await gotoDashboardRoute(page, "/dashboard/agent-profiles");
    await expect(
      page
        .getByRole("heading", { name: "Agents", exact: true })
        .and(page.locator("h1:not(header h1)"))
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser Reviewer");
    await page.getByRole("textbox", { name: "agent/<slug>" }).fill(slug);
    await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("reviewer");
    await page.getByRole("combobox", { name: "Combos", exact: true }).selectOption(comboId);
    await page
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Inspect the actual diff and command evidence.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(`agent/${slug}`, { exact: true })).toBeVisible();
    const listed = await page.request.get("/api/agent-profiles");
    const payload = (await listed.json()) as {
      profiles: Array<{
        id: string;
        slug: string;
        revision: number;
        role: string;
        targetComboId: string;
      }>;
    };
    const profile = payload.profiles.find((candidate) => candidate.slug === slug);
    expect(profile).toMatchObject({ role: "reviewer", targetComboId: comboId });
    profileId = profile?.id;
    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    const file = page
      .locator("details")
      .filter({ has: page.getByText(`.claude/agents/${slug}.md`, { exact: true }) });
    await file.locator("summary").click();
    await expect(file.locator("pre")).toContainText(`model: "agent/${slug}"`);
    await expect(file.locator("pre")).not.toContainText("Bash");
    await page.screenshot({ path: test.info().outputPath("agents-dashboard.png"), fullPage: true });
  } finally {
    if (profileId) {
      const response = await page.request.get(`/api/agent-profiles/${profileId}`);
      if (response.ok()) {
        const profile = (await response.json()) as { revision: number };
        expect(
          (
            await page.request.delete(`/api/agent-profiles/${profileId}`, {
              data: { revision: profile.revision },
            })
          ).status()
        ).toBe(204);
      }
    }
    if (comboId) expect((await page.request.delete(`/api/combos/${comboId}`)).ok()).toBe(true);
    expect(
      (
        await page.request.put("/api/settings/feature-flags", {
          data: {
            key: "AGENT_PROFILES_ENABLED",
            ...(previous?.source === "db" ? { value: previous.effectiveValue } : {}),
          },
        })
      ).status()
    ).toBe(200);
  }
});
