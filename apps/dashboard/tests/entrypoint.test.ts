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
      // Bare hostname, optionally with :port — matches .env.example's
      // VITE_DASHBOARD_HOST=app.rovenue.io and custom-host.ts's
      // `host.split(":")[0]` normalisation. NOT a URL: see the rejection
      // case below.
      ROVENUE_DASHBOARD_HOST: "app.example.com:5173",
    });
    expect(stdout).toContain("ok");
  });

  // custom-host.ts normalises with `host.split(":")[0].toLowerCase()`, so a
  // scheme-bearing value like "https://app.example.com" would normalise to
  // the string "https" and could never match window.location.hostname —
  // silently disabling canonical-host detection instead of failing loudly.
  // ROVENUE_DASHBOARD_HOST must be rejected at container start instead.
  it("rejects a URL for ROVENUE_DASHBOARD_HOST", async () => {
    await expect(
      validate({ ROVENUE_DASHBOARD_HOST: "https://app.example.com" }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ROVENUE_DASHBOARD_HOST"),
    });
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

  // A lone LF is a JS LineTerminator and breaks the unescaped string
  // literal in config.js exactly like an embedded quote would. It also
  // passes the http(s):// prefix check, so it must be caught by check_safe.
  it("rejects a value containing an embedded newline", async () => {
    await expect(
      validate({ ROVENUE_API_URL: "https://a.example.com/\nx" }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ROVENUE_API_URL") });
  });

  // A lone CR is also a JS LineTerminator and survives the http(s)://
  // prefix check the same way a lone LF does.
  it("rejects a value containing an embedded carriage return", async () => {
    await expect(
      validate({ ROVENUE_API_URL: "https://a.example.com/\rx" }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ROVENUE_API_URL") });
  });

  // A backslash is both a JS string escape character and Caddy's own
  // replacer escape character, so it gets the same treatment as the quote
  // and backtick cases above.
  it("rejects a value containing a backslash", async () => {
    await expect(
      validate({ ROVENUE_API_URL: "https://a.example.com/\\x" }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ROVENUE_API_URL") });
  });

  describe("ROVENUE_REQUIRE_RUNTIME_CONFIG", () => {
    // The default, from-source-build path: unset and not required, so the
    // Dockerfile's baked-in VITE_API_URL fallback in runtime-config.ts is
    // allowed to stand.
    it("accepts an unset ROVENUE_API_URL when not required", async () => {
      const { stdout } = await validate({});
      expect(stdout).toContain("ok");
    });

    // The published-image path (release-images.yml bakes this ARG in for
    // rovenue-dashboard only): an operator who forgets ROVENUE_API_URL must
    // get a refused start naming the missing variable, not a dashboard that
    // boots and silently talks to localhost.
    it("rejects an unset ROVENUE_API_URL when required", async () => {
      await expect(
        validate({ ROVENUE_REQUIRE_RUNTIME_CONFIG: "1" }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("ROVENUE_API_URL"),
      });
    });

    it("accepts a set ROVENUE_API_URL when required", async () => {
      const { stdout } = await validate({
        ROVENUE_REQUIRE_RUNTIME_CONFIG: "1",
        ROVENUE_API_URL: "https://api.example.com",
      });
      expect(stdout).toContain("ok");
    });
  });
});
