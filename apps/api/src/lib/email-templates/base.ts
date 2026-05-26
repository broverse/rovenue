export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function shell(innerHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Rovenue</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#0a0a0a;">
${innerHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;">
<p style="font-size:12px;color:#737373;">Rovenue · Self-hosted subscription management.</p>
</body></html>`;
}
