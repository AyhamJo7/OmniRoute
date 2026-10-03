import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(
  new URL("../../../scripts/dev/run-playwright-tests.mjs", import.meta.url)
);

test("browser runner uses the test package when standalone browser and test versions differ", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-browser-runner-"));
  try {
    for (const [name, source] of [
      ["playwright", "process.stderr.write('wrong runner version'); process.exit(47);"],
      ["@playwright/test", "process.stdout.write(JSON.stringify(process.argv.slice(2)));"],
    ]) {
      const folder = path.join(directory, "node_modules", name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "cli.js"), source);
    }
    const result = spawnSync(process.execPath, [runner, "test", "tests/e2e/*.spec.ts", "--list"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["test", "tests/e2e/*.spec.ts", "--list"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
