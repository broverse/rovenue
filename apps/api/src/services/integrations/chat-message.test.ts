import { describe, expect, it } from "vitest";
import { buildChatMessageText, maskSubscriberId } from "./chat-message";
import type { ChatMessageInput } from "./chat-message";

// ---------------------------------------------------------------------------
// Message builder — pure, per event family. Moved verbatim from
// slack.test.ts's `describe("buildSlackMessageText", ...)` block (Task 3:
// the builder was hoisted from providers/slack.ts into this shared module
// for reuse by DISCORD). These assertions are byte-identical to the ones
// that lived in slack.test.ts before the move — same expected strings — so
// a green run here is the proof that the extraction changed nothing about
// Slack's rendered output.
// ---------------------------------------------------------------------------

describe("buildChatMessageText", () => {
  it("maskSubscriberId keeps the first 4 chars + ellipsis", () => {
    expect(maskSubscriberId("sub_123456")).toBe("sub_…");
    expect(maskSubscriberId("abcd")).toBe("abcd…");
  });

  it("revenue family: :moneybag: prefix with amount/currency/productId/subscriber", () => {
    const text = buildChatMessageText({
      eventKey: "revenue.RENEWAL",
      amount: "9.99",
      currency: "USD",
      productId: "prod_gold",
      subscriberId: "sub_123",
    });
    expect(text).toBe(
      ":moneybag: revenue.RENEWAL — 9.99 USD · prod_gold · subscriber sub_…",
    );
  });

  it("subscription family: :repeat: prefix, no amount/currency segment", () => {
    const text = buildChatMessageText({
      eventKey: "subscription.trial.started",
      subscriberId: "sub_123",
    });
    expect(text).toBe(":repeat: subscription.trial.started · subscriber sub_…");
  });

  it("paywall family: :eyes: prefix", () => {
    const text = buildChatMessageText({
      eventKey: "paywall.view",
      subscriberId: "sub_123",
    });
    expect(text).toBe(":eyes: paywall.view · subscriber sub_…");
  });

  it("credit family: :coin: prefix", () => {
    const text = buildChatMessageText({
      eventKey: "credit.ledger.appended",
      subscriberId: "sub_123",
    });
    expect(text).toBe(":coin: credit.ledger.appended · subscriber sub_…");
  });

  it("subscriber.identified is treated as the subscription family", () => {
    const text = buildChatMessageText({ eventKey: "subscriber.identified" });
    expect(text.startsWith(":repeat:")).toBe(true);
  });

  it("omits the productId/subscriber segments entirely when absent", () => {
    const text = buildChatMessageText({ eventKey: "credit.ledger.appended" });
    expect(text).toBe(":coin: credit.ledger.appended");
  });

  it("never includes amount/currency for a non-revenue family even if passed", () => {
    const text = buildChatMessageText({
      eventKey: "subscription.expired",
      amount: "9.99",
      currency: "USD",
    });
    expect(text).not.toContain("9.99");
    expect(text).not.toContain("USD");
  });

  // ---------------------------------------------------------------------
  // PII absence by construction — buildChatMessageText's declared input
  // type (ChatMessageInput) has exactly 5 fields; nothing else it could be
  // called with can leak through, since JS does not strip extra properties
  // off an object passed in (only the compiler would reject them). This
  // proves the *builder itself* is safe, independent of whether callers
  // (slack.ts's mapEvent, and DISCORD's future mapEvent) correctly narrow
  // the envelope before calling in — that narrowing is covered separately
  // by each provider's own mapEvent tests (see slack.test.ts).
  // ---------------------------------------------------------------------

  it("reads nothing beyond eventKey/amount/currency/productId/subscriberId, even if extra PII fields are smuggled onto the input object", () => {
    const smuggledInput = {
      eventKey: "revenue.RENEWAL",
      amount: "9.99",
      currency: "USD",
      productId: "prod_gold",
      subscriberId: "sub_123",
      // None of the following are part of ChatMessageInput; cast past the
      // compiler to prove the function ignores them at runtime too.
      email: "user@example.com",
      phone: "+15551234567",
      identityContext: { email: "ctx@example.com", ip: "203.0.113.5" },
      subscriberAttributes: { customTag: "super-secret-plan-name" },
      payload: { secretField: "leak-me-not" },
    } as unknown as ChatMessageInput;

    const text = buildChatMessageText(smuggledInput);

    expect(text).toBe(
      ":moneybag: revenue.RENEWAL — 9.99 USD · prod_gold · subscriber sub_…",
    );
    expect(text).not.toContain("user@example.com");
    expect(text).not.toContain("ctx@example.com");
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain("203.0.113.5");
    expect(text).not.toContain("customTag");
    expect(text).not.toContain("super-secret-plan-name");
    expect(text).not.toContain("leak-me-not");
  });
});
