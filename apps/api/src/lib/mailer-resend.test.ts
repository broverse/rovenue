import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendMailer } from "./mailer-resend";

function okFetch(body: unknown = { id: "re_123" }) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

describe("ResendMailer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the Resend API and returns the message id", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const m = new ResendMailer({ apiKey: "re_key", from: "noreply@rovenue.app" });
    const out = await m.send({
      to: "user@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(out).toEqual({ messageId: "re_123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: "noreply@rovenue.app",
      to: ["user@example.com"],
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("merges correlationId and extra headers into the headers field", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const m = new ResendMailer({ apiKey: "re_key", from: "noreply@rovenue.app" });
    await m.send({
      to: "user@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
      correlationId: "corr-1",
      headers: { "List-Unsubscribe": "<https://x>" },
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.headers).toEqual({
      "List-Unsubscribe": "<https://x>",
      "X-Rovenue-Id": "corr-1",
    });
  });

  it("throws with status and body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "invalid from" }), { status: 422 }),
      ),
    );

    const m = new ResendMailer({ apiKey: "re_key", from: "noreply@rovenue.app" });
    await expect(
      m.send({ to: "u@e.com", subject: "s", html: "h", text: "t" }),
    ).rejects.toThrow(/resend send failed: 422.*invalid from/);
  });

  it("exposes provider name for metrics", () => {
    const m = new ResendMailer({ apiKey: "k", from: "f@e.com" });
    expect(m.provider).toBe("resend");
  });
});
