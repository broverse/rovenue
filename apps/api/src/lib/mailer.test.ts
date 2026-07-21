import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { env as RealEnv } from "./env";
import {
  __setMailerForTests,
  _SesMailerForTests,
  createMailerFromEnv,
  mailer,
  type Mailer,
} from "./mailer";
import { SmtpMailer } from "./mailer-smtp";
import { ResendMailer } from "./mailer-resend";

type EnvShape = typeof RealEnv;
function baseEnv(overrides: Partial<EnvShape> = {}): EnvShape {
  return {
    EMAIL_PROVIDER: "ses",
    EMAIL_FROM: undefined,
    RESEND_API_KEY: undefined,
    AWS_SES_FROM_EMAIL: undefined,
    AWS_SES_REGION: "us-east-1",
    AWS_SES_CONFIGURATION_SET: undefined,
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_SECURE: false,
    ...overrides,
  } as unknown as EnvShape;
}

describe("mailer", () => {
  afterEach(() => __setMailerForTests(null));

  it("uses an injected mailer for tests", async () => {
    class RecordingMailer implements Mailer {
      readonly provider = "test";
      sent: Array<{ to: string; subject: string }> = [];
      async send(m: { to: string; subject: string; html: string; text: string }) {
        this.sent.push({ to: m.to, subject: m.subject });
        return { messageId: "noop" };
      }
    }
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    const out = await mailer().send({
      to: "a@b.com", subject: "hi", html: "<p>hi</p>", text: "hi",
    });
    expect(out.messageId).toBe("noop");
    expect(rec.sent).toEqual([{ to: "a@b.com", subject: "hi" }]);
  });

  it("SesMailer sends via SESv2 SendEmailCommand with the configured from + config set", async () => {
    const sesMock = mockClient(SESv2Client);
    sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-id-42" });

    const m = new _SesMailerForTests(
      new SESv2Client({ region: "us-east-1" }),
      "noreply@example.com",
      "rovenue-events",
    );

    const out = await m.send({
      to: "alex@example.com",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
      correlationId: "inv_abc",
    });
    expect(out.messageId).toBe("ses-id-42");

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.FromEmailAddress).toBe("noreply@example.com");
    expect(input.Destination?.ToAddresses).toEqual(["alex@example.com"]);
    expect(input.ConfigurationSetName).toBe("rovenue-events");
    expect(input.Content?.Simple?.Subject?.Data).toBe("Welcome");
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "X-Rovenue-Id", Value: "inv_abc" },
    ]);
  });

  it("SesMailer returns empty messageId when SES omits it", async () => {
    const sesMock = mockClient(SESv2Client);
    sesMock.on(SendEmailCommand).resolves({});
    const m = new _SesMailerForTests(
      new SESv2Client({ region: "us-east-1" }),
      "noreply@example.com",
    );
    const out = await m.send({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    expect(out.messageId).toBe("");
  });

  it("SesMailer threads msg.headers + correlationId together", async () => {
    const sesMock = mockClient(SESv2Client);
    sesMock.on(SendEmailCommand).resolves({ MessageId: "id" });
    const m = new _SesMailerForTests(
      new SESv2Client({ region: "us-east-1" }),
      "noreply@example.com",
    );
    await m.send({
      to: "a@b.com",
      subject: "s",
      html: "h",
      text: "t",
      correlationId: "inv_42",
      headers: { "List-Unsubscribe": "<https://x>" },
    });
    const input = sesMock.commandCalls(SendEmailCommand)[0].args[0].input;
    expect(input.Content?.Simple?.Headers).toEqual(
      expect.arrayContaining([
        { Name: "X-Rovenue-Id", Value: "inv_42" },
        { Name: "List-Unsubscribe", Value: "<https://x>" },
      ]),
    );
  });
});

describe("createMailerFromEnv", () => {
  it("returns NoopMailer when SES selected but no from address is set", async () => {
    const m = createMailerFromEnv(baseEnv());
    const r = await m.send({ to: "x@y.com", subject: "s", html: "h", text: "t" });
    expect(r.messageId).toBe("noop");
  });

  it("uses AWS_SES_FROM_EMAIL when EMAIL_FROM is absent", () => {
    const m = createMailerFromEnv(
      baseEnv({ AWS_SES_FROM_EMAIL: "rovenue@example.com" }),
    );
    expect(m.constructor.name).toBe("SesMailer");
  });

  it("builds an SmtpMailer when EMAIL_PROVIDER=smtp and required vars are set", () => {
    const m = createMailerFromEnv(
      baseEnv({
        EMAIL_PROVIDER: "smtp",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: 587,
        SMTP_USER: "u",
        SMTP_PASS: "p",
        EMAIL_FROM: "rovenue@example.com",
      }),
    );
    expect(m).toBeInstanceOf(SmtpMailer);
  });

  it("throws when EMAIL_PROVIDER=smtp but SMTP_* or from is missing", () => {
    expect(() =>
      createMailerFromEnv(
        baseEnv({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "rovenue@example.com" }),
      ),
    ).toThrow(/EMAIL_PROVIDER=smtp requires/);
    expect(() =>
      createMailerFromEnv(
        baseEnv({
          EMAIL_PROVIDER: "smtp",
          SMTP_HOST: "h",
          SMTP_PORT: 25,
          SMTP_USER: "u",
          SMTP_PASS: "p",
        }),
      ),
    ).toThrow(/EMAIL_PROVIDER=smtp requires/);
  });

  it("EMAIL_PROVIDER=resend with key + from builds a ResendMailer", () => {
    const m = createMailerFromEnv(
      baseEnv({
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_key",
        EMAIL_FROM: "noreply@rovenue.app",
      }),
    );
    expect(m).toBeInstanceOf(ResendMailer);
  });

  it("EMAIL_PROVIDER=resend without key falls back to SES when a from address exists", () => {
    const m = createMailerFromEnv(
      baseEnv({
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: undefined,
        AWS_SES_FROM_EMAIL: "noreply@rovenue.app",
      }),
    );
    expect(m).not.toBeInstanceOf(ResendMailer);
    expect(m.provider).toBe("ses");
  });

  it("EMAIL_PROVIDER=resend with nothing configured is a noop mailer", async () => {
    const m = createMailerFromEnv(
      baseEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined }),
    );
    const out = await m.send({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    expect(out.messageId).toBe("noop");
  });
});
