import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// ESM package — no __dirname. apps/dashboard/tests -> repo root is three up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "deploy", "dashboard", "entrypoint.sh");

/**
 * VALIDATE_ONLY short-circuits before `exec caddy run`, so the real script
 * is exercised here — not a reimplementation of its rules.
 */
async function validate(env: Record<string, string>) {
  return execFileAsync("sh", [SCRIPT], {
    env: { ...process.env, VALIDATE_ONLY: "1", ...env },
  });
}

describe("dashboard entrypoint validation", () => {
  it("accepts a fully unset environment", async () => {
    const { stdout } = await validate({});
    expect(stdout).toContain("ok");
  });

  it("accepts valid values", async () => {
    const { stdout } = await validate({
      ROVENUE_API_URL: "https://api.example.com",
      ROVENUE_HOST_MODE: "cloud",
      ROVENUE_ALLOW_REGISTRATION: "true",
      ROVENUE_DASHBOARD_HOST: "https://app.example.com",
    });
    expect(stdout).toContain("ok");
  });

  it("rejects a non-absolute API URL", async () => {
    await expect(validate({ ROVENUE_API_URL: "api.example.com" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_API_URL"),
    });
  });

  // The reason validation exists at all: Caddy's {$VAR} substitution is
  // textual, so a quote would emit a syntactically broken config.js and the
  // dashboard would fail to boot with no explanation.
  it("rejects a value containing a quote", async () => {
    await expect(
      validate({ ROVENUE_API_URL: 'https://a.example.com/"' }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ROVENUE_API_URL") });
  });

  it("rejects an unknown host mode", async () => {
    await expect(validate({ ROVENUE_HOST_MODE: "staging" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_HOST_MODE"),
    });
  });

  it("rejects a non-boolean allowRegistration", async () => {
    await expect(validate({ ROVENUE_ALLOW_REGISTRATION: "yes" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_ALLOW_REGISTRATION"),
    });
  });
});
