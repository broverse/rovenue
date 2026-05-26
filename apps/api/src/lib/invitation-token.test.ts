import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "./invitation-token";

describe("invitation-token", () => {
  it("emits a token with the rov_inv_ prefix and url-safe body", () => {
    const t = generateInvitationToken();
    expect(t.plaintext).toMatch(/^rov_inv_[A-Za-z0-9_-]{40,}$/);
    expect(t.hash).toHaveLength(64); // sha256 hex
  });

  it("hash matches between generation and re-hash", () => {
    const t = generateInvitationToken();
    expect(hashInvitationToken(t.plaintext)).toBe(t.hash);
  });

  it("hashes are deterministic across calls", () => {
    expect(hashInvitationToken("abc")).toBe(hashInvitationToken("abc"));
  });

  it("generated tokens are unique across calls", () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateInvitationToken().plaintext);
    }
    expect(tokens.size).toBe(50);
  });
});
