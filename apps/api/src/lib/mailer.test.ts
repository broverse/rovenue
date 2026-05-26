import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  __setMailerForTests,
  _SesMailerForTests,
  mailer,
  type Mailer,
} from "./mailer";

describe("mailer", () => {
  afterEach(() => __setMailerForTests(null));

  it("uses an injected mailer for tests", async () => {
    class RecordingMailer implements Mailer {
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
});
