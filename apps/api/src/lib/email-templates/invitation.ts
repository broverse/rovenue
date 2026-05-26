import type { MemberRoleName } from "@rovenue/shared";
import { escapeHtml, shell } from "./base";

export interface InvitationEmailParams {
  inviterName: string;
  projectName: string;
  role: MemberRoleName;
  inviteUrl: string;
  expiresAt: Date;
}

export function renderInvitationEmail(p: InvitationEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const inviter = escapeHtml(p.inviterName);
  const project = escapeHtml(p.projectName);
  const role = escapeHtml(p.role);
  const url = p.inviteUrl;
  const expires = p.expiresAt.toUTCString();

  const subject = `You've been invited to ${p.projectName} on Rovenue`;

  const html = shell(`
<h1 style="font-size:20px;margin:0 0 16px;">You're invited to join ${project}</h1>
<p style="font-size:14px;line-height:1.6;">
  <strong>${inviter}</strong> invited you to join <strong>${project}</strong>
  as a <strong>${role}</strong>.
</p>
<p style="margin:24px 0;">
  <a href="${url}" style="background:#0a0a0a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;">
    Accept invitation
  </a>
</p>
<p style="font-size:12px;color:#737373;">
  This link expires on ${expires}. If you didn't expect this email you can ignore it.
</p>`);

  const text = [
    `You're invited to join ${p.projectName}`,
    "",
    `${p.inviterName} invited you to join ${p.projectName} as a ${p.role}.`,
    "",
    `Accept the invitation: ${url}`,
    "",
    `This link expires on ${expires}.`,
  ].join("\n");

  return { subject, html, text };
}
