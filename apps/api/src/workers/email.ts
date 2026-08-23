import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { drizzle } from "@rovenue/db";
import { renderTemplate } from "@rovenue/email-templates";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { mailer } from "../lib/mailer";

const log = logger.child("email-worker");

export const EMAIL_QUEUE_NAME = "rovenue-email";

export interface InvitationEmailJobData {
  type: "invitation.send";
  invitationId: string;
  /** Plaintext invite URL (the token is only known at create/resend time). */
  inviteUrl: string;
}

let cachedQueue: Queue | undefined;
export function getEmailQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EMAIL_QUEUE_NAME, {
    connection: createBullConnection("email"),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/** Enqueue an invitation send. inviteUrl carries the plaintext token. */
export async function enqueueInvitationEmail(
  invitationId: string,
  inviteUrl: string,
): Promise<void> {
  const queue = getEmailQueue();
  await queue.add(
    "invitation.send",
    { type: "invitation.send", invitationId, inviteUrl } satisfies InvitationEmailJobData,
    { jobId: `inv-${invitationId}-${Date.now()}` },
  );
}

/**
 * Pure worker entrypoint, exported so unit tests can call it without
 * spinning up a real BullMQ worker.
 */
/**
 * A send claim younger than this is treated as another in-flight send of
 * the same invitation (BullMQ stall redelivery / concurrent duplicate) and
 * skipped. Must stay below the dashboard resend cooldown (60s) so a
 * legitimate operator resend is never swallowed by a stale claim.
 */
const SEND_CLAIM_STALE_MS = 30_000;

export async function runInvitationEmailJob(args: {
  invitationId: string;
  inviteUrl: string;
}): Promise<{ sent: true; messageId: string } | { skipped: string }> {
  const load = await drizzle.invitationRepo.findInvitationForEmailSend(
    drizzle.db,
    args.invitationId,
  );
  if (!load) return { skipped: "not_pending" };

  // Atomic single-flight claim BEFORE the provider send: if the process
  // dies between `mailer().send()` succeeding and `patchSendResult`
  // committing, BullMQ's stalled-job redelivery re-runs this job — without
  // the claim, the invitee got the email twice. A concurrent duplicate job
  // (double-fired resend) hits the same gate.
  const now = new Date();
  const claimed = await drizzle.invitationRepo.claimInvitationForSend(
    drizzle.db,
    args.invitationId,
    { now, staleBefore: new Date(now.getTime() - SEND_CLAIM_STALE_MS) },
  );
  if (!claimed) return { skipped: "claimed_by_inflight_send" };

  const { subject, html, text } = await renderTemplate({
    eventKey: "team.member.invited",
    locale: "en",
    context: {
      projectId: load.projectId,
      projectName: load.projectName,
      inviterName: load.inviterName,
      role: load.invitation.role,
      acceptUrl: args.inviteUrl,
      expiresAt: load.invitation.expiresAt.toUTCString(),
    },
    managePreferencesUrl: `${env.DASHBOARD_URL}/account/notifications`,
  });

  let result: Awaited<ReturnType<ReturnType<typeof mailer>["send"]>>;
  try {
    result = await mailer().send({
      to: load.invitation.email,
      subject,
      html,
      text,
      correlationId: args.invitationId,
    });
  } catch (sendErr) {
    // The email never went out — release the claim synchronously so the
    // BullMQ retry can re-claim immediately instead of waiting out the
    // stale window, then rethrow as the retry signal.
    await drizzle.invitationRepo.releaseInvitationSendClaim(
      drizzle.db,
      args.invitationId,
    );
    throw sendErr;
  }

  await drizzle.invitationRepo.patchSendResult(drizzle.db, args.invitationId, {
    sesMessageId: result.messageId,
    lastSentAt: new Date(),
  });

  return { sent: true, messageId: result.messageId };
}

let cachedWorker: Worker | undefined;
export function createEmailWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker<InvitationEmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<InvitationEmailJobData>) => {
      if (job.data.type !== "invitation.send") return;
      return runInvitationEmailJob({
        invitationId: job.data.invitationId,
        inviteUrl: job.data.inviteUrl,
      });
    },
    {
      connection: createBullConnection("email"),
      concurrency: 5,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("email job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}
