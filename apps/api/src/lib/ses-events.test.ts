import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSesEvent, type SesEventPatch } from "./ses-events";

function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "__fixtures__", `ses-${name}.json`),
    "utf8",
  );
}

describe("parseSesEvent", () => {
  it("Permanent bounce → BOUNCED with diagnostic", () => {
    const out = parseSesEvent(fixture("bounce")) as SesEventPatch;
    expect(out).toEqual({
      configurationSet: "rovenue-events",
      sesMessageId: "ses-msg-1",
      status: "BOUNCED",
      error: "550 user unknown",
    });
  });

  it("Complaint → COMPLAINED with null error", () => {
    const out = parseSesEvent(fixture("complaint")) as SesEventPatch;
    expect(out.status).toBe("COMPLAINED");
    expect(out.sesMessageId).toBe("ses-msg-2");
    expect(out.error).toBeNull();
  });

  it("Delivery → DELIVERED with no error", () => {
    const out = parseSesEvent(fixture("delivery")) as SesEventPatch;
    expect(out.status).toBe("DELIVERED");
    expect(out.error).toBeNull();
  });

  it("Transient bounce → null (ignored)", () => {
    const transient = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Transient", bouncedRecipients: [] },
      mail: {
        messageId: "x",
        tags: { "ses:configuration-set": ["rovenue-events"] },
      },
    });
    expect(parseSesEvent(transient)).toBeNull();
  });

  it("Reject → BOUNCED with 'rejected' error", () => {
    const reject = JSON.stringify({
      notificationType: "Reject",
      reject: { reason: "Bad content" },
      mail: {
        messageId: "ses-msg-r",
        tags: { "ses:configuration-set": ["rovenue-events"] },
      },
    });
    const out = parseSesEvent(reject) as SesEventPatch;
    expect(out.status).toBe("BOUNCED");
    expect(out.error).toBe("rejected");
  });

  it("unknown notificationType → null", () => {
    const unknown = JSON.stringify({
      notificationType: "Unknown",
      mail: { messageId: "x" },
    });
    expect(parseSesEvent(unknown)).toBeNull();
  });

  it("malformed JSON → null", () => {
    expect(parseSesEvent("{not json")).toBeNull();
  });

  it("missing mail.messageId → null", () => {
    const missing = JSON.stringify({
      notificationType: "Delivery",
      delivery: { recipients: [] },
      mail: {},
    });
    expect(parseSesEvent(missing)).toBeNull();
  });
});
