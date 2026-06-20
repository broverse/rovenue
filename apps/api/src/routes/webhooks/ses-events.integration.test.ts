// =============================================================
// SES bounce/complaint webhook integration tests
//
// Requires: real Postgres.
// No Redis / BullMQ / SES dependency.
//
// NOTE on env-var ordering: `env` is parsed from process.env at
// module load time by Zod. Setting process.env vars BEFORE any
// imports ensures the env singleton sees the correct values.
// AWS_SES_EVENTS_VERIFY_SIGNATURE=false skips real SNS cert
// verification so tests work without genuine AWS certs.
//
// Test #2 (configuration-set mismatch guard) is skipped here
// because env.AWS_SES_CONFIGURATION_SET is evaluated at import
// time and cannot be mutated post-import cleanly. That path is
// covered by the unit-level test in ses-events.test.ts.
// =============================================================

process.env.AWS_SES_EVENTS_VERIFY_SIGNATURE = "false";
process.env.AWS_SES_CONFIGURATION_SET = "rovenue-events";

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { generateInvitationToken } from "../../lib/invitation-token";
import { sesEventsRoute } from "./ses-events";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route("/webhooks/ses-events", sesEventsRoute);
}

/** Minimal SNS Notification envelope wrapping a JSON-stringified SES event. */
let _snsSeq = 0;
function snsNotification(sesEvent: unknown, messageId?: string) {
  return {
    Type: "Notification",
    // Each call gets a unique MessageId so the W4.1 dedup guard doesn't
    // collapse independent test cases that legitimately send different events.
    MessageId: messageId ?? `sns-msg-${RUN_ID}-${++_snsSeq}`,
    TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
    Message: JSON.stringify(sesEvent),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "FAKE",
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
  };
}

function sesBounceEvent(
  messageId: string,
  diagnosticCode = "550 unknown",
  recipient = "bounce@example.com",
) {
  return {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: recipient, diagnosticCode }],
      timestamp: new Date().toISOString(),
      feedbackId: `fb-${RUN_ID}`,
    },
    mail: {
      messageId,
      tags: { "ses:configuration-set": ["rovenue-events"] },
    },
  };
}

function sesComplaintEvent(messageId: string, recipient: string) {
  return {
    notificationType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: recipient }],
      timestamp: new Date().toISOString(),
      feedbackId: `fb-c-${RUN_ID}`,
    },
    mail: {
      messageId,
      tags: { "ses:configuration-set": ["rovenue-events"] },
    },
  };
}

function sesDeliveryEvent(messageId: string, recipient: string) {
  return {
    notificationType: "Delivery",
    delivery: {
      recipients: [recipient],
      timestamp: new Date().toISOString(),
      processingTimeMillis: 100,
      smtpResponse: "250 2.6.0",
      reportingMTA: "a8-123.smtp-out.amazonses.com",
    },
    mail: {
      messageId,
      tags: { "ses:configuration-set": ["rovenue-events"] },
    },
  };
}

async function seedNotificationDelivery(opts: {
  userId: string;
  providerMessageId: string;
}) {
  const db = getDb();
  const [notif] = await db
    .insert(drizzle.schema.notifications)
    .values({
      userId: opts.userId,
      eventKey: "team.member.invited",
      eventId: `evt-${RUN_ID}-${Math.random()}`,
      title: "t",
      body: "b",
    })
    .returning();
  if (!notif) throw new Error("no notification");
  const [delivery] = await db
    .insert(drizzle.schema.notificationDeliveries)
    .values({
      notificationId: notif.id,
      channel: "email",
      status: "sent",
      providerMessageId: opts.providerMessageId,
    })
    .returning();
  if (!delivery) throw new Error("no delivery");
  return { notification: notif, delivery };
}

// ---------- Seed helpers ----------

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_ses_wh_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `SES Webhook Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function createUser(suffix: string) {
  const email = `ses_wh_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!seswh";
  const name = `SES WH User ${suffix}`;
  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);
  return { userId: signUp.user.id };
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// =============================================================
// 1. Notification (Bounce) → invitation row flips to BOUNCED
// =============================================================

describe("POST /webhooks/ses-events", () => {
  it("1. Bounce notification patches deliveryStatus to BOUNCED", async () => {
    const { userId } = await createUser("bounce1");
    const project = await seedProject("_bounce1");
    trackProject(project.id);

    // Create invitation
    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const invitation = await drizzle.invitationRepo.createInvitation(
      drizzle.db,
      {
        projectId: project.id,
        email: "bounce_target@rovenue.test",
        role: "DEVELOPER",
        tokenHash: token.hash,
        invitedByUserId: userId,
        expiresAt,
      },
    );

    // Stamp a known sesMessageId via patchSendResult
    const sesMessageId = `ses-msg-bounce-${RUN_ID}`;
    await drizzle.invitationRepo.patchSendResult(drizzle.db, invitation.id, {
      sesMessageId,
      lastSentAt: new Date(),
    });

    const app = buildApp();
    const body = snsNotification(sesBounceEvent(sesMessageId));
    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // Verify the DB row was patched
    const db = getDb();
    const rows = await db
      .select()
      .from(drizzle.schema.projectInvitations)
      .where(eq(drizzle.schema.projectInvitations.id, invitation.id))
      .limit(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row!.deliveryStatus).toBe("BOUNCED");
    expect(row!.deliveryError).toBe("550 unknown");
  });

  // =============================================================
  // 2. Notification with no matching invitation → 200, no-op
  // =============================================================

  it("2. Bounce for unknown messageId returns 200 without error", async () => {
    const app = buildApp();
    const unknownId = `ses-msg-no-match-${RUN_ID}`;
    const body = snsNotification(sesBounceEvent(unknownId));
    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    // No assertion on DB — the repo silently updates 0 rows, which is fine
  });

  // =============================================================
  // 3. SubscriptionConfirmation → 200 ok (confirm fetch attempted)
  // =============================================================

  it("3. SubscriptionConfirmation returns 200 ok", async () => {
    const app = buildApp();
    // SubscribeURL must be a valid URL; fetch will fail in test env but
    // the handler catches the error and still returns { ok: true }.
    const body = {
      Type: "SubscriptionConfirmation",
      MessageId: `sub-confirm-${RUN_ID}`,
      TopicArn: "arn:aws:sns:us-east-1:123456789012:rovenue-ses",
      Message: "You have chosen to subscribe to the topic.",
      Token: "fake-token",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/confirm-fake",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "FAKE",
      SigningCertURL:
        "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    };

    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  // =============================================================
  // 4. Bounce on a notification_delivery → suppression + 'bounced'
  // =============================================================

  it("4. Bounce on a notification delivery suppresses + marks 'bounced'", async () => {
    const { userId } = await createUser("notif-bounce");
    const sesMessageId = `ses-msg-notif-bounce-${RUN_ID}`;
    const recipient = `bounce_notif_${RUN_ID}@rovenue.test`;
    const { delivery } = await seedNotificationDelivery({
      userId,
      providerMessageId: sesMessageId,
    });

    const app = buildApp();
    const body = snsNotification(
      sesBounceEvent(sesMessageId, "550 unknown", recipient),
    );
    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const updated = await drizzle.db
      .select()
      .from(drizzle.schema.notificationDeliveries)
      .where(eq(drizzle.schema.notificationDeliveries.id, delivery.id));
    expect(updated[0]?.status).toBe("bounced");
    expect(
      await drizzle.notificationSuppressionRepo.isSuppressed(
        drizzle.db,
        recipient.toLowerCase(),
      ),
    ).toBe(true);
  });

  // =============================================================
  // 5. Complaint → suppression + delivery 'bounced' + email disabled
  // =============================================================

  it("5. Complaint suppresses recipient + disables user email channel", async () => {
    const { userId } = await createUser("notif-complaint");
    const sesMessageId = `ses-msg-notif-complaint-${RUN_ID}`;
    const recipient = `complaint_notif_${RUN_ID}@rovenue.test`;
    const { delivery } = await seedNotificationDelivery({
      userId,
      providerMessageId: sesMessageId,
    });

    const app = buildApp();
    const body = snsNotification(sesComplaintEvent(sesMessageId, recipient));
    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const updated = await drizzle.db
      .select()
      .from(drizzle.schema.notificationDeliveries)
      .where(eq(drizzle.schema.notificationDeliveries.id, delivery.id));
    expect(updated[0]?.status).toBe("bounced");

    const check = await drizzle.notificationSuppressionRepo.get(
      drizzle.db,
      recipient.toLowerCase(),
    );
    expect(check?.reason).toBe("complaint");

    const channels =
      await drizzle.notificationPreferencesRepo.getUserChannels(
        drizzle.db,
        userId,
      );
    expect(channels?.email).toBe(false);
  });

  // =============================================================
  // 6. Delivery success → 'delivered' on the notification row
  // =============================================================

  it("6. Delivery notification flips delivery to 'delivered'", async () => {
    const { userId } = await createUser("notif-deliv");
    const sesMessageId = `ses-msg-notif-deliv-${RUN_ID}`;
    const { delivery } = await seedNotificationDelivery({
      userId,
      providerMessageId: sesMessageId,
    });

    const app = buildApp();
    const body = snsNotification(
      sesDeliveryEvent(sesMessageId, `deliv_${RUN_ID}@rovenue.test`),
    );
    const res = await app.request("/webhooks/ses-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const updated = await drizzle.db
      .select()
      .from(drizzle.schema.notificationDeliveries)
      .where(eq(drizzle.schema.notificationDeliveries.id, delivery.id));
    expect(updated[0]?.status).toBe("delivered");
  });
});
