import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { mailer } from "../lib/mailer";
import { renderInvitationEmail } from "../lib/email-templates";
import type { MemberRoleName } from "@rovenue/shared";

const log = logger.child("email-worker");

export const EMAIL_QUEUE_NAME = "rovenue-email";

export interface InvitationEmailJobData {
  type: "invitation.send";
  invitationId: string;
  /** Plaintext invite URL (the token is only known at create/resend time). */
  inviteUrl: string;
}

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;
export function getEmailQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EMAIL_QUEUE_NAME, {
    connection: createBullConnection(),
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
export async function runInvitationEmailJob(args: {
  invitationId: string;
  inviteUrl: string;
}): Promise<{ sent: true; messageId: string } | { skipped: string }> {
  const load = await drizzle.invitationRepo.findInvitationForEmailSend(
    drizzle.db,
    args.invitationId,
  );
  if (!load) return { skipped: "not_pending" };

  const { subject, html, text } = renderInvitationEmail({
    inviterName: load.inviterName,
    projectName: load.projectName,
    role: load.invitation.role as MemberRoleName,
    inviteUrl: args.inviteUrl,
    expiresAt: load.invitation.expiresAt,
  });

  const result = await mailer().send({
    to: load.invitation.email,
    subject,
    html,
    text,
    correlationId: args.invitationId,
  });

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
      connection: createBullConnection(),
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
