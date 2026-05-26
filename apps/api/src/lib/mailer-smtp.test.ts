import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { SmtpMailer } from "./mailer-smtp";

function stubTransport(sendMail: ReturnType<typeof vi.fn>) {
  vi.spyOn(nodemailer, "createTransport").mockReturnValue({
    sendMail,
  } as never);
}

describe("SmtpMailer", () => {
  it("sends through the configured transport and returns the messageId", async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ messageId: "<abc@host>" });
    stubTransport(sendMail);

    const m = new SmtpMailer({
      host: "smtp.example.com",
      port: 587,
      user: "u",
      pass: "p",
      secure: false,
      from: "Rovenue <notifications@rovenue.io>",
    });
    const r = await m.send({
      to: "x@y.com",
      subject: "hi",
      html: "<b>hello</b>",
      text: "hello",
      headers: { "List-Unsubscribe": "<https://x>" },
    });
    expect(r.messageId).toBe("<abc@host>");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Rovenue <notifications@rovenue.io>",
        to: "x@y.com",
        subject: "hi",
        html: "<b>hello</b>",
        text: "hello",
        headers: { "List-Unsubscribe": "<https://x>" },
      }),
    );
  });

  it("merges correlationId into outgoing headers as X-Rovenue-Id", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "id" });
    stubTransport(sendMail);

    const m = new SmtpMailer({
      host: "h",
      port: 25,
      user: "u",
      pass: "p",
      secure: false,
      from: "r@r",
    });
    await m.send({
      to: "x@y.com",
      subject: "s",
      html: "h",
      text: "t",
      correlationId: "inv_42",
      headers: { "List-Unsubscribe": "<u>" },
    });
    expect(sendMail.mock.calls[0]![0].headers).toEqual({
      "List-Unsubscribe": "<u>",
      "X-Rovenue-Id": "inv_42",
    });
  });

  it("omits headers entirely when nothing is set", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "id" });
    stubTransport(sendMail);

    const m = new SmtpMailer({
      host: "h",
      port: 25,
      user: "u",
      pass: "p",
      secure: false,
      from: "r@r",
    });
    await m.send({ to: "x@y.com", subject: "s", html: "h", text: "t" });
    expect(sendMail.mock.calls[0]![0].headers).toBeUndefined();
  });
});
