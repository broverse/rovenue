import { describe, expect, it, vi } from "vitest";
import { pseudonymizeMessage } from "./pseudonymize";

const fakeLookup = vi.fn();

describe("pseudonymizeMessage", () => {
  it("replaces emails with resolved subscriber ids", async () => {
    fakeLookup.mockResolvedValueOnce("sub_K1xQ");
    const { text, mapping } = await pseudonymizeMessage({
      projectId: "prj_1",
      input: "refund alice@acme.com please",
      resolveByEmail: fakeLookup,
    });
    expect(text).toBe("refund sub_K1xQ please");
    expect(mapping.get("alice@acme.com")).toBe("sub_K1xQ");
    expect(fakeLookup).toHaveBeenCalledWith("prj_1", "alice@acme.com");
  });

  it("leaves text unchanged when no email/uuid is present", async () => {
    const { text, mapping } = await pseudonymizeMessage({
      projectId: "prj_1",
      input: "show MRR for last quarter",
      resolveByEmail: fakeLookup,
    });
    expect(text).toBe("show MRR for last quarter");
    expect(mapping.size).toBe(0);
  });

  it("dedupes multiple mentions of the same email", async () => {
    fakeLookup.mockReset().mockResolvedValueOnce("sub_K1xQ");
    const { text } = await pseudonymizeMessage({
      projectId: "prj_1",
      input: "alice@acme.com and alice@acme.com again",
      resolveByEmail: fakeLookup,
    });
    expect(text).toBe("sub_K1xQ and sub_K1xQ again");
    expect(fakeLookup).toHaveBeenCalledTimes(1);
  });

  it("drops unresolved emails (no mapping, original kept)", async () => {
    fakeLookup.mockReset().mockResolvedValueOnce(null);
    const { text, mapping } = await pseudonymizeMessage({
      projectId: "prj_1",
      input: "who is ghost@nowhere.io?",
      resolveByEmail: fakeLookup,
    });
    expect(text).toBe("who is ghost@nowhere.io?");
    expect(mapping.size).toBe(0);
  });
});
