import { describe, expect, it } from "vitest";
import { parseAllowedOrigin } from "./allowed-origins";

// An allowed origin is an authorization-adjacent value: it decides whose
// JavaScript may use a public API key inside a visitor's browser. Everything
// rejected here is rejected because accepting it would widen that silently.

describe("parseAllowedOrigin", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    // A trailing slash is what a browser's own `location.origin` never has
    // but a human typing into a form always does.
    ["https://app.example.com/", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://app.example.com:8443", "https://app.example.com:8443"],
    // Case in the host is not significant; the browser sends it lowered.
    ["https://APP.example.com", "https://app.example.com"],
    ["  https://app.example.com  ", "https://app.example.com"],
  ])("accepts %s", (input, expected) => {
    expect(parseAllowedOrigin(input)).toBe(expected);
  });

  it.each([
    // A subdomain takeover would become an API key.
    ["https://*.example.com", "wildcard host"],
    ["*", "bare wildcard"],
    // A path is not part of an origin; accepting one implies a scoping the
    // browser will not enforce.
    ["https://app.example.com/admin", "path"],
    ["https://app.example.com/?a=b", "query"],
    ["https://app.example.com/#x", "fragment"],
    // Without a scheme there is no origin to compare against.
    ["app.example.com", "no scheme"],
    ["//app.example.com", "protocol-relative"],
    // Non-http schemes never appear as a browser Origin header.
    ["file:///etc/passwd", "file scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["data:text/html,x", "data scheme"],
    ["", "empty"],
    ["   ", "blank"],
    ["not a url", "not a url"],
    // Credentials in an origin are meaningless and hide the real host.
    ["https://user:pass@app.example.com", "credentials"],
  ])("rejects %s (%s)", (input) => {
    expect(parseAllowedOrigin(input)).toBeNull();
  });

  it("is idempotent — parsing its own output returns the same value", () => {
    const once = parseAllowedOrigin("https://app.example.com/");
    expect(once).not.toBeNull();
    expect(parseAllowedOrigin(once as string)).toBe(once);
  });
});
