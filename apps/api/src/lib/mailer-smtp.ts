import nodemailer, { type Transporter } from "nodemailer";
import type { Mailer, MailMessage } from "./mailer";

export interface SmtpMailerOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** STARTTLS when false; implicit TLS (port 465) when true. */
  secure: boolean;
  from: string;
}

/**
 * Mailer backed by nodemailer's SMTP transport. Used as the SES fallback
 * for self-hosted deployments without AWS credentials.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly opts: SmtpMailerOptions) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
    });
  }

  async send(msg: MailMessage): Promise<{ messageId: string }> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}) };
    if (msg.correlationId) headers["X-Rovenue-Id"] = msg.correlationId;

    const result = await this.transport.sendMail({
      from: this.opts.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    return { messageId: result.messageId ?? "" };
  }
}
