# Resend Email Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Resend as the default email provider (send + delivery-event webhook) while keeping the SES and SMTP paths fully functional.

**Architecture:** A new `ResendMailer` implements the existing `Mailer` interface via plain `fetch` (no new deps). `EMAIL_PROVIDER` gains `"resend"` and becomes the default, with a safety fallback to SES when `RESEND_API_KEY` is unset. A new `/webhooks/resend-events` route verifies Svix signatures (hand-rolled, mirroring `sns-signature.ts`) and reuses the exact side-effect flow of `ses-events` (invitation status, notification deliveries, suppression list, complaint master-switch flip).

**Tech Stack:** Hono, Zod env schema, Drizzle repos, Redis dedup, Vitest. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-21-resend-email-provider-design.md`

## Global Constraints

- TypeScript strict; no new npm dependencies.
- All work happens on the **current branch** (`main`) — never create branches.
- Conventional commits; commit after each task.
- Test runner: `pnpm --filter @rovenue/api exec vitest run <path>` (unit only; do not run `*.integration.test.ts` — they need testcontainers).
- Typecheck gate per task: `pnpm --filter @rovenue/api typecheck`.
- Env is read via `apps/api/src/lib/env.ts` (frozen at import); tests that need env values must set `process.env.*` **before** any imports that read env.

---

### Task 1: ResendMailer (send path)

**Files:**
- Create: `apps/api/src/lib/mailer-resend.ts`
- Test: `apps/api/src/lib/mailer-resend.test.ts`

**Interfaces:**
- Consumes: `Mailer`, `MailMessage` from `./mailer` (existing).
- Produces: `export class ResendMailer implements Mailer` with `constructor(opts: { apiKey: string; from: string })`, `readonly provider = "resend"`, `send(msg: MailMessage): Promise<{ messageId: string }>`. Task 2 imports `ResendMailer` from `./mailer-resend`.

- [x] **Step 1: Write the failing test**

`apps/api/src/lib/mailer-resend.test.ts`:

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/mailer-resend.test.ts`
Expected: FAIL — cannot resolve `./mailer-resend`.

- [x] **Step 3: Write the implementation**

`apps/api/src/lib/mailer-resend.ts`:

```ts
import type { Mailer, MailMessage } from "./mailer";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendMailerOptions {
  apiKey: string;
  from: string;
}

/**
 * Mailer backed by the Resend HTTP API (https://resend.com/docs/api-reference).
 * Plain fetch, matching the push transports (lib/push/fcm.ts, apns.ts) —
 * one POST does not warrant the official SDK dependency.
 */
export class ResendMailer implements Mailer {
  readonly provider = "resend";

  constructor(private readonly opts: ResendMailerOptions) {}

  async send(msg: MailMessage): Promise<{ messageId: string }> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}) };
    if (msg.correlationId) headers["X-Rovenue-Id"] = msg.correlationId;

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend send failed: ${res.status} ${body}`.trimEnd());
    }
    const out = (await res.json()) as { id?: string };
    return { messageId: out.id ?? "" };
  }
}
```

Note: `readonly provider` is not on the `Mailer` interface yet (Task 3 adds it); the extra field is harmless until then.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/mailer-resend.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Typecheck + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/lib/mailer-resend.ts apps/api/src/lib/mailer-resend.test.ts
git commit -m "feat(api): add ResendMailer send transport"
```

---

### Task 2: Env schema + provider selection (resend default, SES fallback)

**Files:**
- Modify: `apps/api/src/lib/env.ts` (EMAIL_PROVIDER enum + Resend block)
- Modify: `apps/api/src/lib/mailer.ts` (`createMailerFromEnv` resend branch)
- Modify: `.env.example` (email section)
- Test: `apps/api/src/lib/mailer.test.ts` (extend)

**Interfaces:**
- Consumes: `ResendMailer` from `./mailer-resend` (Task 1).
- Produces: env keys `RESEND_API_KEY?: string`, `RESEND_WEBHOOK_SECRET?: string`, `RESEND_EVENTS_VERIFY_SIGNATURE: boolean` (Task 6 reads the latter two); `EMAIL_PROVIDER` typed `"resend" | "ses" | "smtp"` defaulting to `"resend"`.

- [x] **Step 1: Write the failing tests**

Append to the `describe("mailer", ...)` block in `apps/api/src/lib/mailer.test.ts` (also add `import { ResendMailer } from "./mailer-resend";` at the top, and add `RESEND_API_KEY: undefined,` to the `baseEnv` object literal):

```ts
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
    // SesMailer is not exported directly; assert via the provider label
    // once Task 3 lands. Until then: not Resend, not Noop.
    expect(m).not.toBeInstanceOf(ResendMailer);
    expect(m.send).toBeTypeOf("function");
  });

  it("EMAIL_PROVIDER=resend with nothing configured is a noop mailer", async () => {
    const m = createMailerFromEnv(
      baseEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined }),
    );
    const out = await m.send({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    expect(out.messageId).toBe("noop");
  });
```

(After Task 3 adds `Mailer.provider`, tighten the fallback assertion to `expect(m.provider).toBe("ses")` — Task 3 Step 3 does this.)

- [x] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/mailer.test.ts`
Expected: the resend selection tests FAIL (resend branch missing → falls into the SES/noop default paths).

- [x] **Step 3: Implement env additions**

In `apps/api/src/lib/env.ts`, replace the email transport selection block:

```ts
    // ---- Email transport selection -----------------------------
    // EMAIL_PROVIDER picks the Mailer impl. "resend" is the default
    // (uses RESEND_API_KEY below; falls back to SES when the key is
    // missing but AWS_SES_* is configured — protects deployments that
    // upgraded past the default flip). "ses" uses AWS_SES_* above.
    // "smtp" enables the nodemailer path for self-hosted instances
    // without AWS credentials or a Resend account.
    EMAIL_PROVIDER: z.enum(["resend", "ses", "smtp"]).default("resend"),
```

Directly below it (before `EMAIL_FROM`), add:

```ts
    // ---- Resend (default email transport) ----------------------
    RESEND_API_KEY: z.string().min(1).optional(),
    // Svix signing secret ("whsec_…") for /webhooks/resend-events.
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
    RESEND_EVENTS_VERIFY_SIGNATURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
```

- [x] **Step 4: Implement the selection branch**

In `apps/api/src/lib/mailer.ts`:
- Add `import { ResendMailer } from "./mailer-resend";`
- Update the selection-rules doc comment above `createMailerFromEnv` to:

```ts
/**
 * Build a Mailer from the runtime env. Exposed so tests can construct
 * one with a custom env shape; the singleton `mailer()` builds via
 * the loaded process env.
 *
 * Selection rules:
 *   - EMAIL_PROVIDER=smtp → SmtpMailer (requires SMTP_HOST/PORT/USER/PASS + a from address)
 *   - EMAIL_PROVIDER=resend (default) + RESEND_API_KEY + from → ResendMailer
 *   - EMAIL_PROVIDER=resend without RESEND_API_KEY → SES fallback when a
 *     from address is set (deployments upgrading past the default flip
 *     keep sending), else NoopMailer
 *   - EMAIL_PROVIDER=ses + from set → SesMailer
 *   - otherwise → NoopMailer (dev convenience; logs and returns id="noop")
 */
```

- Inside `createMailerFromEnv`, after the smtp branch, insert:

```ts
  if (e.EMAIL_PROVIDER === "resend") {
    if (e.RESEND_API_KEY && from) {
      return new ResendMailer({ apiKey: e.RESEND_API_KEY, from });
    }
    if (from) {
      // Default-flip safety: "resend" became the default provider; an
      // instance configured only for SES keeps its SES path instead of
      // silently degrading to noop.
      logger.info("mailer.resend_fallback_ses", {
        reason: "RESEND_API_KEY missing",
      });
      const client = new SESv2Client({ region: e.AWS_SES_REGION });
      return new SesMailer(client, from, e.AWS_SES_CONFIGURATION_SET ?? undefined);
    }
    return new NoopMailer();
  }
```

(The existing trailing `if (!from) return new NoopMailer(); … SesMailer` block stays and now only serves `EMAIL_PROVIDER=ses`.)

- [x] **Step 5: Update `.env.example`**

Replace the `EMAIL_PROVIDER` comment block + line (currently documents `ses` as default) with:

```
# EMAIL_PROVIDER selects the Mailer adapter:
#   - "resend" → RESEND_* below (default)
#   - "ses"    → AWS_SES_* below
#   - "smtp"   → SMTP_* below (self-hosted, no AWS creds required)
# All paths take the from address from EMAIL_FROM; on the SES path the
# older AWS_SES_FROM_EMAIL is consulted as a fallback. If "resend" is
# selected without RESEND_API_KEY, the mailer falls back to SES when a
# from address is configured.
EMAIL_PROVIDER=resend

# ---- Resend (used when EMAIL_PROVIDER=resend) --------------------------
RESEND_API_KEY=
# Svix signing secret ("whsec_...") from the Resend dashboard webhook
# endpoint pointing at /webhooks/resend-events.
RESEND_WEBHOOK_SECRET=
RESEND_EVENTS_VERIFY_SIGNATURE=true
```

Keep the existing SES and SMTP blocks unchanged (only the header comment above SES changes from "(used when EMAIL_PROVIDER=ses)" to "(used when EMAIL_PROVIDER=ses, or as resend fallback)").

- [x] **Step 6: Run tests, typecheck, commit**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/mailer.test.ts src/lib/mailer-resend.test.ts`
Expected: PASS.
Run: `pnpm --filter @rovenue/api typecheck`
Expected: clean.

```bash
git add apps/api/src/lib/env.ts apps/api/src/lib/mailer.ts apps/api/src/lib/mailer.test.ts .env.example
git commit -m "feat(api): resend is the default EMAIL_PROVIDER with SES fallback"
```

---

### Task 3: `Mailer.provider` metrics label

**Files:**
- Modify: `apps/api/src/lib/mailer.ts` (interface + SesMailer + NoopMailer)
- Modify: `apps/api/src/lib/mailer-smtp.ts`
- Modify: `apps/api/src/workers/send-email-worker.ts:117` (hardcoded `"ses"`)
- Modify (test implementers): `apps/api/src/lib/mailer.test.ts` (`RecordingMailer`), `apps/api/src/workers/email.test.ts` (`RecordingMailer`), `apps/api/src/workers/send-email-worker.integration.test.ts` (`StubMailer`)

**Interfaces:**
- Produces: `Mailer` interface gains `readonly provider: string`. Values: `"resend"` (already set in Task 1), `"ses"`, `"smtp"`, `"noop"`, `"test"` (test doubles).

- [x] **Step 1: Add the field to the interface and all implementers**

In `apps/api/src/lib/mailer.ts`:

```ts
export interface Mailer {
  /** Short transport name used as the metrics label (e.g. "resend", "ses"). */
  readonly provider: string;
  send(msg: MailMessage): Promise<{ messageId: string }>;
}
```

Add `readonly provider = "ses";` as the first member of `SesMailer` and `readonly provider = "noop";` to `NoopMailer`. In `mailer-smtp.ts` add `readonly provider = "smtp";` to `SmtpMailer`. In the three test doubles add `readonly provider = "test";`.

- [x] **Step 2: Use it in the worker**

In `apps/api/src/workers/send-email-worker.ts` replace:

```ts
      observeSendDuration("email", "ses", "ok", performance.now() - startMs);
```

with:

```ts
      observeSendDuration("email", deps.mailer.provider, "ok", performance.now() - startMs);
```

Also grep the file for any other hardcoded `"ses"` transport label (e.g. in the `failed` handler's `observeSendDuration` call, if present) and replace the same way. Do NOT touch the `rateLimit` comment mentioning the SES sandbox.

- [x] **Step 3: Tighten the Task 2 fallback test**

In `apps/api/src/lib/mailer.test.ts`, in the test `"EMAIL_PROVIDER=resend without key falls back to SES when a from address exists"`, replace the two weak assertions with:

```ts
    expect(m.provider).toBe("ses");
```

- [x] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/mailer.test.ts src/lib/mailer-smtp.test.ts src/lib/mailer-resend.test.ts src/workers/email.test.ts`
Expected: PASS.
Run: `pnpm --filter @rovenue/api typecheck`
Expected: clean — this is the real gate: it catches any `implements Mailer` site missed in Step 1.

- [x] **Step 5: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(api): Mailer.provider label replaces hardcoded ses metrics transport"
```

---

### Task 4: Svix signature verification

**Files:**
- Create: `apps/api/src/lib/svix-signature.ts`
- Test: `apps/api/src/lib/svix-signature.test.ts`

**Interfaces:**
- Produces: `verifySvixSignature(headers: SvixHeaders, rawBody: string, secret: string, nowMs?: number): void` (throws on failure) and `interface SvixHeaders { id: string | undefined; timestamp: string | undefined; signature: string | undefined }`. Task 6 consumes both.

Scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual): key = base64-decode of the secret after the `whsec_` prefix; expected = base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)); the `svix-signature` header is a space-separated list of `v1,<base64>` entries — any match passes; timestamps outside ±5 minutes are rejected.

- [x] **Step 1: Write the failing tests**

`apps/api/src/lib/svix-signature.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature } from "./svix-signature";

const KEY = Buffer.from("test-secret-key-material");
const SECRET = `whsec_${KEY.toString("base64")}`;
const BODY = '{"type":"email.delivered"}';

function sign(id: string, timestamp: string, body: string): string {
  return createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("verifySvixSignature", () => {
  it("accepts a valid signature", () => {
    const ts = String(nowSec());
    const sig = sign("msg_1", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
        BODY,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("accepts when only the second of multiple v1 entries matches", () => {
    const ts = String(nowSec());
    const good = sign("msg_1", ts, BODY);
    const bad = sign("msg_other", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${bad} v1,${good}` },
        BODY,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const ts = String(nowSec());
    const sig = sign("msg_1", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
        '{"type":"email.bounced"}',
        SECRET,
      ),
    ).toThrow(/no matching/);
  });

  it("rejects a timestamp outside the 5-minute tolerance", () => {
    const stale = String(nowSec() - 6 * 60);
    const sig = sign("msg_1", stale, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: stale, signature: `v1,${sig}` },
        BODY,
        SECRET,
      ),
    ).toThrow(/tolerance/);
  });

  it("rejects missing headers", () => {
    expect(() =>
      verifySvixSignature(
        { id: undefined, timestamp: String(nowSec()), signature: "v1,x" },
        BODY,
        SECRET,
      ),
    ).toThrow(/missing/);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: "not-a-number", signature: "v1,x" },
        BODY,
        SECRET,
      ),
    ).toThrow(/timestamp/);
  });

  it("rejects an empty/undecodable secret", () => {
    const ts = String(nowSec());
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: "v1,x" },
        BODY,
        "whsec_",
      ),
    ).toThrow(/secret/);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/svix-signature.test.ts`
Expected: FAIL — cannot resolve `./svix-signature`.

- [x] **Step 3: Write the implementation**

`apps/api/src/lib/svix-signature.ts`:

```ts
// =============================================================
// Svix webhook signature verification (hand-rolled)
// =============================================================
//
// Resend signs delivery-event webhooks with the Svix scheme:
//   expected = base64( HMAC-SHA256( key, `${svix-id}.${svix-timestamp}.${rawBody}` ) )
// where key is the base64-decoded remainder of the "whsec_…" secret.
// The `svix-signature` header carries a space-separated list of
// `v1,<base64>` candidates (key-rotation window) — any match passes.
// Mirrors lib/sns-signature.ts: small, dependency-free, throw-on-fail.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** Throws unless `rawBody` carries a valid, fresh Svix signature. */
export function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now(),
): void {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new Error("missing svix headers");
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) throw new Error("invalid svix-timestamp");
  if (Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) {
    throw new Error("svix-timestamp outside tolerance");
  }

  const encoded = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) throw new Error("undecodable webhook secret");

  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest();

  for (const part of headers.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return;
    }
  }
  throw new Error("no matching svix signature");
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/svix-signature.test.ts`
Expected: PASS (7 tests).

- [x] **Step 5: Typecheck + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/lib/svix-signature.ts apps/api/src/lib/svix-signature.test.ts
git commit -m "feat(api): hand-rolled Svix webhook signature verification"
```

---

### Task 5: Resend event parser

**Files:**
- Create: `apps/api/src/lib/resend-events.ts`
- Test: `apps/api/src/lib/resend-events.test.ts`

**Interfaces:**
- Consumes: `type DeliveryStatus` from `./ses-events` (existing: `"DELIVERED" | "BOUNCED" | "COMPLAINED"`).
- Produces: `parseResendEvent(rawBody: string): ResendEventPatch | null` with `interface ResendEventPatch { providerMessageId: string; status: DeliveryStatus; error: string | null; recipients: string[] }`. Task 6 consumes both.

- [x] **Step 1: Write the failing tests**

`apps/api/src/lib/resend-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseResendEvent } from "./resend-events";

function envelope(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, created_at: "2026-07-21T10:00:00.000Z", data });
}

describe("parseResendEvent", () => {
  it("maps email.delivered to DELIVERED with lowercased recipients", () => {
    const patch = parseResendEvent(
      envelope("email.delivered", { email_id: "re_1", to: ["User@Example.com"] }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_1",
      status: "DELIVERED",
      error: null,
      recipients: ["user@example.com"],
    });
  });

  it("maps a permanent email.bounced to BOUNCED with diagnostic error", () => {
    const patch = parseResendEvent(
      envelope("email.bounced", {
        email_id: "re_2",
        to: ["u@e.com"],
        bounce: { type: "Permanent", subType: "General", message: "550 no such user" },
      }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_2",
      status: "BOUNCED",
      error: "Permanent: General: 550 no such user",
      recipients: ["u@e.com"],
    });
  });

  it("treats a bounce without a type as permanent", () => {
    const patch = parseResendEvent(
      envelope("email.bounced", { email_id: "re_3", to: ["u@e.com"] }),
    );
    expect(patch?.status).toBe("BOUNCED");
    expect(patch?.error).toBe("bounced");
  });

  it("ignores transient bounces", () => {
    expect(
      parseResendEvent(
        envelope("email.bounced", {
          email_id: "re_4",
          to: ["u@e.com"],
          bounce: { type: "Transient", message: "mailbox full" },
        }),
      ),
    ).toBeNull();
  });

  it("maps email.complained to COMPLAINED", () => {
    const patch = parseResendEvent(
      envelope("email.complained", { email_id: "re_5", to: ["u@e.com"] }),
    );
    expect(patch).toEqual({
      providerMessageId: "re_5",
      status: "COMPLAINED",
      error: null,
      recipients: ["u@e.com"],
    });
  });

  it("accepts a string `to` field", () => {
    const patch = parseResendEvent(
      envelope("email.delivered", { email_id: "re_6", to: "Solo@E.com" }),
    );
    expect(patch?.recipients).toEqual(["solo@e.com"]);
  });

  it("ignores non-delivery event types", () => {
    for (const type of ["email.sent", "email.opened", "email.clicked", "email.delivery_delayed", "contact.created"]) {
      expect(parseResendEvent(envelope(type, { email_id: "re_7", to: ["u@e.com"] }))).toBeNull();
    }
  });

  it("returns null for malformed JSON, missing type, or missing email_id", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: { email_id: "x" } }))).toBeNull();
    expect(parseResendEvent(envelope("email.delivered", { to: ["u@e.com"] }))).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resend-events.test.ts`
Expected: FAIL — cannot resolve `./resend-events`.

- [x] **Step 3: Write the implementation**

`apps/api/src/lib/resend-events.ts`:

```ts
import type { DeliveryStatus } from "./ses-events";

export interface ResendEventPatch {
  providerMessageId: string;
  status: DeliveryStatus;
  error: string | null;
  recipients: string[];
}

interface ResendEnvelope {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { message?: string; type?: string; subType?: string };
  };
}

/**
 * Parse a Resend webhook payload into the same patch shape the SES
 * consumer produces. Returns null for events we intentionally ignore
 * (transient bounces, sent/opened/clicked/delayed, unknown types,
 * malformed JSON).
 */
export function parseResendEvent(rawBody: string): ResendEventPatch | null {
  let evt: ResendEnvelope;
  try {
    evt = JSON.parse(rawBody) as ResendEnvelope;
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object" || !evt.type) return null;

  const emailId = evt.data?.email_id;
  if (!emailId) return null;

  const toRaw = evt.data?.to;
  const recipients = (Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : []).map(
    (r) => r.toLowerCase(),
  );

  switch (evt.type) {
    case "email.delivered":
      return { providerMessageId: emailId, status: "DELIVERED", error: null, recipients };
    case "email.bounced": {
      // Same policy as parseSesEvent: only permanent (hard) bounces drive
      // suppression. Resend surfaces the underlying bounce classification;
      // a missing type is treated as permanent (terminal bounce event).
      const bounce = evt.data?.bounce;
      if (bounce?.type && bounce.type.toLowerCase() !== "permanent") return null;
      const diag = [bounce?.type, bounce?.subType, bounce?.message]
        .filter(Boolean)
        .join(": ");
      return {
        providerMessageId: emailId,
        status: "BOUNCED",
        error: diag || "bounced",
        recipients,
      };
    }
    case "email.complained":
      return { providerMessageId: emailId, status: "COMPLAINED", error: null, recipients };
    default:
      return null;
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resend-events.test.ts`
Expected: PASS (8 tests).

- [x] **Step 5: Typecheck + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/lib/resend-events.ts apps/api/src/lib/resend-events.test.ts
git commit -m "feat(api): parse Resend delivery-event webhooks"
```

---

### Task 6: `/webhooks/resend-events` route

**Files:**
- Create: `apps/api/src/routes/webhooks/resend-events.ts`
- Modify: `apps/api/src/routes/webhooks/index.ts` (mount)
- Test: `apps/api/src/routes/webhooks/resend-events.test.ts`

**Interfaces:**
- Consumes: `verifySvixSignature`/`SvixHeaders` (Task 4), `parseResendEvent` (Task 5), env keys `RESEND_WEBHOOK_SECRET` + `RESEND_EVENTS_VERIFY_SIGNATURE` (Task 2); Drizzle repos exactly as `ses-events.ts` uses them.
- Produces: `export const resendEventsRoute: Hono` mounted at `/webhooks/resend-events`.

- [x] **Step 1: Write the failing route tests**

`apps/api/src/routes/webhooks/resend-events.test.ts` — mirrors the mock scaffolding of `ses-events.test.ts` (env before imports, hoisted `vi.mock` factories):

```ts
// =============================================================
// Resend events route — unit tests
//
// No real Postgres, Redis, or Resend dependency.
// - signature verification is ON (real HMACs computed in-test)
// - svix-id dedup short-circuits replays
// - suppression + master-switch side effects on bounce/complaint
// =============================================================

// Must come before any imports that read env.
process.env.RESEND_EVENTS_VERIFY_SIGNATURE = "true";
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("route-test-key").toString("base64")}`;
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "redis://localhost:6379";

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      invitationRepo: {
        setDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationDeliveryRepo: {
        findDeliveryByProviderMessageId: vi.fn().mockResolvedValue(null),
        markDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationSuppressionRepo: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      notificationPreferencesRepo: {
        updateUserChannels: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

import { redis } from "../../lib/redis";
import { drizzle } from "@rovenue/db";
import { resendEventsRoute } from "./resend-events";

const redisMock = redis as unknown as { set: ReturnType<typeof vi.fn> };
const drizzleMock = drizzle as unknown as {
  invitationRepo: { setDeliveryStatus: ReturnType<typeof vi.fn> };
  notificationDeliveryRepo: {
    findDeliveryByProviderMessageId: ReturnType<typeof vi.fn>;
    markDeliveryStatus: ReturnType<typeof vi.fn>;
  };
  notificationSuppressionRepo: { add: ReturnType<typeof vi.fn> };
  notificationPreferencesRepo: { updateUserChannels: ReturnType<typeof vi.fn> };
};

const KEY = Buffer.from("route-test-key");

function signedRequest(body: string, overrides: Partial<Record<string, string>> = {}) {
  const id = overrides["svix-id"] ?? "msg_1";
  const timestamp = overrides["svix-timestamp"] ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides["svix-signature"] ??
    `v1,${createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body,
  });
}

function deliveredBody(emailId = "re_1"): string {
  return JSON.stringify({
    type: "email.delivered",
    data: { email_id: emailId, to: ["user@example.com"] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue("OK");
  drizzleMock.notificationDeliveryRepo.findDeliveryByProviderMessageId.mockResolvedValue(null);
});

describe("resend-events route", () => {
  it("rejects a request with a bad signature", async () => {
    const res = await resendEventsRoute.request(
      signedRequest(deliveredBody(), { "svix-signature": "v1,AAAA" }),
    );
    expect(res.status).toBe(403);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });

  it("accepts a validly signed delivery and patches invitation status", async () => {
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalledWith(
      expect.anything(),
      "re_1",
      "DELIVERED",
      null,
    );
  });

  it("dedups a replayed svix-id without reprocessing", async () => {
    redisMock.set.mockResolvedValue(null); // NX miss → already seen
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });

  it("fails open when redis errors", async () => {
    redisMock.set.mockRejectedValue(new Error("redis down"));
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalled();
  });

  it("bounce suppresses recipients and marks the delivery bounced", async () => {
    drizzleMock.notificationDeliveryRepo.findDeliveryByProviderMessageId.mockResolvedValue({
      id: "del_1",
      notificationId: "not_1",
    });
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "re_2",
        to: ["Bounced@Example.com"],
        bounce: { type: "Permanent", subType: "General", message: "550" },
      },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.notificationSuppressionRepo.add).toHaveBeenCalledWith(
      expect.anything(),
      { email: "bounced@example.com", reason: "hard_bounce", source: "resend" },
    );
    expect(drizzleMock.notificationDeliveryRepo.markDeliveryStatus).toHaveBeenCalledWith(
      expect.anything(),
      "del_1",
      "bounced",
      expect.objectContaining({ providerResponse: expect.anything() }),
    );
  });

  it("complaint suppresses the recipient with reason complaint", async () => {
    const body = JSON.stringify({
      type: "email.complained",
      data: { email_id: "re_3", to: ["angry@example.com"] },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.notificationSuppressionRepo.add).toHaveBeenCalledWith(
      expect.anything(),
      { email: "angry@example.com", reason: "complaint", source: "resend" },
    );
  });

  it("ignores non-delivery events with a 200", async () => {
    const body = JSON.stringify({
      type: "email.opened",
      data: { email_id: "re_4", to: ["user@example.com"] },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });
});
```

Note on the complaint master-switch flip: `ses-events.ts` resolves the notification's `userId` via `drizzle.db.select(...)`; with `db` mocked as `{}` that query path can't run in a unit test, so (as in `ses-events.test.ts`) the flip's full path is left to the integration test. The unit test asserts the suppression write; keep the route code path identical to ses-events.

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/webhooks/resend-events.test.ts`
Expected: FAIL — cannot resolve `./resend-events`.

- [x] **Step 3: Write the route**

`apps/api/src/routes/webhooks/resend-events.ts`:

```ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { redis } from "../../lib/redis";
import { parseResendEvent } from "../../lib/resend-events";
import { verifySvixSignature } from "../../lib/svix-signature";

const log = logger.child("resend-events");

export const resendEventsRoute = new Hono().post("/", async (c) => {
  // Raw body first: the Svix signature covers the exact bytes on the wire.
  const rawBody = await c.req.text();

  // Fail closed: signature verification is MANDATORY in production; the
  // flag can only RELAX it in non-production (local testing without real
  // Svix signatures). Same threat model as ses-events: an unauthenticated
  // caller could otherwise poison the suppression list (permanent
  // denial-of-email for a victim) or flip a user's email master switch.
  const mustVerify =
    env.NODE_ENV === "production" || env.RESEND_EVENTS_VERIFY_SIGNATURE;
  if (mustVerify) {
    if (!env.RESEND_WEBHOOK_SECRET) {
      log.warn("RESEND_WEBHOOK_SECRET unset; rejecting event");
      return c.json({ ok: false }, 403);
    }
    try {
      verifySvixSignature(
        {
          id: c.req.header("svix-id"),
          timestamp: c.req.header("svix-timestamp"),
          signature: c.req.header("svix-signature"),
        },
        rawBody,
        env.RESEND_WEBHOOK_SECRET,
      );
    } catch (e) {
      log.warn("rejected resend payload", {
        err: e instanceof Error ? e.message : String(e),
      });
      return c.json({ ok: false }, 403);
    }
  }

  // svix-id dedup — Svix delivers at-least-once; guard against a replayed
  // event re-applying suppression / status writes. Fail open on Redis
  // error so a cache outage doesn't drop live events.
  const svixId = c.req.header("svix-id");
  if (svixId) {
    const dedupKey = `resend:seen:${svixId}`;
    try {
      const added = await redis.set(dedupKey, "1", "EX", 3600, "NX");
      if (added !== "OK") {
        log.info("resend event deduplicated", { svixId });
        return c.json({ ok: true });
      }
    } catch (err) {
      log.warn("resend dedup redis error, failing open", {
        svixId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const patch = parseResendEvent(rawBody);
  if (!patch) return c.json({ ok: true });

  await drizzle.invitationRepo.setDeliveryStatus(
    drizzle.db,
    patch.providerMessageId,
    patch.status,
    patch.error,
  );

  // ---------- notifications pipeline side-effects ----------
  //
  // Same event also drives the notification_deliveries status + the
  // global suppression list + the per-user email master switch — the
  // exact flow ses-events runs. Lookup is by providerMessageId, which
  // the send-email-worker stores when the provider accepts the send.
  // Missing row → the event is for a non-notification send (e.g. an
  // invitation), so the invitation patch above is all there is to do.
  const delivery =
    await drizzle.notificationDeliveryRepo.findDeliveryByProviderMessageId(
      drizzle.db,
      patch.providerMessageId,
    );

  if (patch.status === "DELIVERED") {
    if (delivery) {
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "delivered",
      );
    }
    return c.json({ ok: true });
  }

  if (patch.status === "BOUNCED") {
    // parseResendEvent already filtered out transient bounces, so every
    // recipient here is a hard bounce → permanent suppression.
    for (const email of patch.recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "hard_bounce",
        source: "resend",
      });
    }
    if (delivery) {
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "bounced",
        { providerResponse: { error: patch.error, recipients: patch.recipients } },
      );
    }
    return c.json({ ok: true });
  }

  if (patch.status === "COMPLAINED") {
    for (const email of patch.recipients) {
      await drizzle.notificationSuppressionRepo.add(drizzle.db, {
        email,
        reason: "complaint",
        source: "resend",
      });
    }
    if (delivery) {
      // Flip the user's email master switch — a spam complaint is a
      // strong "stop sending me anything" signal across every category.
      const notifRows = await drizzle.db
        .select({ userId: drizzle.schema.notifications.userId })
        .from(drizzle.schema.notifications)
        .where(eq(drizzle.schema.notifications.id, delivery.notificationId))
        .limit(1);
      const userId = notifRows[0]?.userId;
      if (userId) {
        await drizzle.notificationPreferencesRepo.updateUserChannels(
          drizzle.db,
          userId,
          { email: false },
        );
      }
      await drizzle.notificationDeliveryRepo.markDeliveryStatus(
        drizzle.db,
        delivery.id,
        "bounced",
        { providerResponse: { reason: "complaint", recipients: patch.recipients } },
      );
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
```

- [x] **Step 4: Mount the route**

In `apps/api/src/routes/webhooks/index.ts` add the import and two chain lines (keep the single-expression chain shape):

```ts
import { resendEventsRoute } from "./resend-events";
```

```ts
export const webhooksRoute = new Hono()
  .use("/apple/*", storeLimit("apple"))
  .use("/google/*", storeLimit("google"))
  .use("/stripe/*", storeLimit("stripe"))
  .use("/ses-events", storeLimit("ses"))
  .use("/resend-events", storeLimit("resend"))
  .route("/apple", appleWebhookRoute)
  .route("/google", googleWebhookRoute)
  .route("/ses-events", sesEventsRoute)
  .route("/resend-events", resendEventsRoute)
  .route("/stripe", stripeWebhookRoute);
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/webhooks/resend-events.test.ts src/routes/webhooks/ses-events.test.ts`
Expected: PASS (both files — ses-events proves the mount change didn't regress).

- [x] **Step 6: Full unit suite, typecheck, commit**

Run: `pnpm --filter @rovenue/api exec vitest run --exclude '**/*.integration.test.ts' src`
Expected: PASS (pre-existing failures listed in memory notes aside — do not fix unrelated reds).
Run: `pnpm --filter @rovenue/api typecheck`
Expected: clean.

```bash
git add apps/api/src/routes/webhooks/resend-events.ts apps/api/src/routes/webhooks/resend-events.test.ts apps/api/src/routes/webhooks/index.ts
git commit -m "feat(api): /webhooks/resend-events delivery-event consumer"
```

---

## Out of scope / deploy-time checklist (not code)

1. Set `RESEND_API_KEY` and `EMAIL_FROM` (domain verified in Resend).
2. Resend dashboard → Webhooks → add endpoint `https://<api-host>/webhooks/resend-events`, subscribe to `email.delivered`, `email.bounced`, `email.complained`; copy the signing secret into `RESEND_WEBHOOK_SECRET`.
