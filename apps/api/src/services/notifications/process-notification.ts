import { eq } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import { renderTemplate } from "@rovenue/email-templates";
import { getEvent } from "@rovenue/shared/notifications";
import { logger } from "../../lib/logger";
import type { Env } from "../../lib/env";
import type {
  SendEmailJob,
  SendEmailQueue,
  SendPushJob,
  SendPushQueue,
} from "../../queues/notifier";
import type { NotifyPayload } from "../../workers/notifier";
import { buildEmailHeaders } from "./email-headers";
import type { PrefsCache } from "./prefs-cache";
import { resolvePrefs } from "./resolve-prefs";
import { resolveRecipients } from "./recipient-resolver";
import { isEmailSuppressed } from "./suppression";

// =============================================================
// processNotification — notifier hot-path
// =============================================================
//
// For one inbound Kafka message:
//   1. Resolve recipient userIds (catalog scope → DB lookup, or
//      explicit list when scope is 'self').
//   2. For each recipient, layer userOverrides ← projectDefaults
//      ← user channel master to decide which channels fan out.
//   3. Render the template once per recipient (locale varies).
//   4. In a tx: insertNotificationIdempotent + bulk insert
//      delivery rows.
//   5. After commit: enqueue send-email / send-push BullMQ jobs.
//
// Email suppression and the per-event pushAllowed flag short-
// circuit the corresponding delivery row to status='suppressed'
// (resp. omit the channel before the row is even written when
// the catalog says push isn't allowed for the event).

const log = logger.child("notifier.process");

const { user } = drizzle.schema;
const {
  notificationRepo,
  notificationPreferencesRepo,
  notificationDeliveryRepo,
} = drizzle;

export interface ProcessNotificationDeps {
  db: Db;
  env: Pick<Env, "DASHBOARD_URL" | "UNSUB_SIGNING_KEY" | "UNSUB_MAILTO">;
  prefsCache: PrefsCache;
  sendEmailQueue: SendEmailQueue;
  sendPushQueue: SendPushQueue;
}

export interface ProcessOutcome {
  /** userIds that fanned out at least one channel (in-app row inserted). */
  recipientsNotified: string[];
  /** Send-email job ids enqueued (deliveryId values). */
  enqueuedEmail: string[];
  /** Send-push job ids enqueued. */
  enqueuedPush: string[];
  /** Recipients skipped because every channel was suppressed/disabled. */
  recipientsSkipped: string[];
  /** Recipients that were idempotency duplicates (notification row already existed). */
  recipientsDuplicate: string[];
}

export async function processNotification(
  deps: ProcessNotificationDeps,
  payload: NotifyPayload,
): Promise<ProcessOutcome> {
  const outcome: ProcessOutcome = {
    recipientsNotified: [],
    enqueuedEmail: [],
    enqueuedPush: [],
    recipientsSkipped: [],
    recipientsDuplicate: [],
  };

  // Cheap sanity check — `resolveRecipients` and `resolvePrefs`
  // also call `getEvent`, but doing it up front turns an unknown
  // eventKey into a single thrown error instead of a partial
  // fan-out followed by a per-recipient explosion.
  getEvent(payload.eventKey);

  const recipients = await resolveRecipients(deps.db, {
    eventKey: payload.eventKey,
    projectId: payload.projectId,
    recipients: payload.recipients,
  });
  if (recipients.length === 0) {
    log.debug("no_recipients", {
      eventKey: payload.eventKey,
      eventId: payload.eventId,
    });
    return outcome;
  }

  // Pending send-jobs are enqueued only after the tx commits, so
  // a rollback can't leak a job for a row that no longer exists.
  const postCommit: Array<() => Promise<void>> = [];

  for (const userId of recipients) {
    const userChannels = await getUserChannelsCached(deps, userId);
    const projectDefaults = payload.projectId
      ? await getProjectDefaultsCached(deps, payload.projectId)
      : {};
    const userOverrides = payload.projectId
      ? await notificationPreferencesRepo.getUserProjectOverrides(
          deps.db,
          userId,
          payload.projectId,
        )
      : {};

    const prefs = await resolvePrefs({
      userChannels: { email: userChannels.email, push: userChannels.push },
      projectDefaults,
      userOverrides,
      eventKey: payload.eventKey,
    });

    if (prefs.enabledChannels.length === 0) {
      outcome.recipientsSkipped.push(userId);
      continue;
    }

    const userEmail = await getUserEmail(deps.db, userId);

    const managePreferencesUrl = `${deps.env.DASHBOARD_URL}/account/notifications`;
    const emailEnabled = prefs.enabledChannels.includes("email");
    const unsubHeaders =
      emailEnabled && userEmail && deps.env.UNSUB_SIGNING_KEY
        ? buildEmailHeaders({
            eventKey: payload.eventKey,
            userId,
            projectId: payload.projectId,
            dashboardUrl: deps.env.DASHBOARD_URL,
            signingKey: deps.env.UNSUB_SIGNING_KEY,
            mailtoUnsub: deps.env.UNSUB_MAILTO,
          })
        : {};
    const unsubscribeUrl = extractUnsubscribeUrl(unsubHeaders);

    const rendered = await renderTemplate({
      eventKey: payload.eventKey,
      locale: userChannels.locale,
      context: payload.context,
      managePreferencesUrl,
      unsubscribeUrl,
    });

    // Decide each channel's initial delivery status before the
    // tx so the insert is a single statement with the right rows.
    const channelStatuses: Array<{
      channel: "email" | "push" | "inapp";
      status: "delivered" | "queued" | "suppressed";
      suppressReason?: "suppressed_list" | "no_email";
    }> = [];

    for (const ch of prefs.enabledChannels) {
      if (ch === "inapp") {
        channelStatuses.push({ channel: "inapp", status: "delivered" });
      } else if (ch === "email") {
        if (!userEmail) {
          channelStatuses.push({
            channel: "email",
            status: "suppressed",
            suppressReason: "no_email",
          });
          continue;
        }
        const suppressed = await isEmailSuppressed(deps.db, userEmail);
        channelStatuses.push({
          channel: "email",
          status: suppressed ? "suppressed" : "queued",
          suppressReason: suppressed ? "suppressed_list" : undefined,
        });
      } else if (ch === "push") {
        channelStatuses.push({ channel: "push", status: "queued" });
      }
    }

    const txResult = await deps.db.transaction(async (tx) => {
      const inserted = await notificationRepo.insertNotificationIdempotent(tx, {
        userId,
        projectId: payload.projectId ?? null,
        eventKey: payload.eventKey,
        eventId: payload.eventId,
        title: rendered.pushTitle,
        body: rendered.pushBody,
        data: payload.context,
      });

      if (!inserted) return null; // duplicate — skip

      const deliveryRows = await notificationDeliveryRepo.insertNotificationDeliveries(
        tx,
        channelStatuses.map((cs) => ({
          notificationId: inserted.id,
          channel: cs.channel,
          status: cs.status,
          providerResponse: cs.suppressReason
            ? ({ reason: cs.suppressReason } as Record<string, unknown>)
            : undefined,
        })),
      );

      return { notification: inserted, deliveries: deliveryRows };
    });

    if (!txResult) {
      outcome.recipientsDuplicate.push(userId);
      continue;
    }

    outcome.recipientsNotified.push(userId);

    // Build the post-commit job-enqueue list. Email and push jobs
    // both reference deliveryId so the send-worker can transition
    // status on success/failure.
    for (const delivery of txResult.deliveries) {
      if (delivery.status !== "queued") continue;
      if (delivery.channel === "email" && userEmail) {
        const job: SendEmailJob = {
          deliveryId: delivery.id,
          to: userEmail,
          headers: unsubHeaders,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        };
        postCommit.push(async () => {
          await deps.sendEmailQueue.add(job);
          outcome.enqueuedEmail.push(delivery.id);
        });
      } else if (delivery.channel === "push") {
        const job: SendPushJob = {
          deliveryId: delivery.id,
          userId,
          title: rendered.pushTitle,
          body: rendered.pushBody,
          data: {
            eventKey: payload.eventKey,
            ...(payload.projectId ? { projectId: payload.projectId } : {}),
          },
        };
        postCommit.push(async () => {
          await deps.sendPushQueue.add(job);
          outcome.enqueuedPush.push(delivery.id);
        });
      }
    }
  }

  // Fire post-commit work. Failures here are logged but don't
  // re-throw — the row exists, the send-worker retry/backoff
  // will get to it on the next scheduler tick. (Phase 10 wires
  // a periodic re-queue scan for stuck deliveries.)
  for (const fn of postCommit) {
    try {
      await fn();
    } catch (err) {
      log.error("enqueue_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcome;
}

async function getUserEmail(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

// ---------- cached lookups ----------

interface CachedUserChannels {
  email: boolean;
  push: boolean;
  locale: string;
  timezone: string;
}

async function getUserChannelsCached(
  deps: ProcessNotificationDeps,
  userId: string,
): Promise<CachedUserChannels> {
  const cached = deps.prefsCache.userPrefs.get(userId) as
    | CachedUserChannels
    | undefined;
  if (cached) return cached;
  const row = await notificationPreferencesRepo.getUserChannels(deps.db, userId);
  const channels: CachedUserChannels = row ?? {
    email: true,
    push: true,
    locale: "en",
    timezone: "UTC",
  };
  deps.prefsCache.userPrefs.set(userId, channels);
  return channels;
}

async function getProjectDefaultsCached(
  deps: ProcessNotificationDeps,
  projectId: string,
): Promise<Record<string, boolean>> {
  const cached = deps.prefsCache.projectDefaults.get(projectId) as
    | Record<string, boolean>
    | undefined;
  if (cached) return cached;
  const row = await notificationPreferencesRepo.getProjectDefaults(
    deps.db,
    projectId,
  );
  deps.prefsCache.projectDefaults.set(projectId, row);
  return row;
}

function extractUnsubscribeUrl(
  headers: Record<string, string>,
): string | undefined {
  // List-Unsubscribe shape: `<https://…/unsubscribe?token=…>, <mailto:…>`.
  const raw = headers["List-Unsubscribe"];
  if (!raw) return undefined;
  const m = raw.match(/<(https?:[^>]+)>/);
  return m?.[1];
}
