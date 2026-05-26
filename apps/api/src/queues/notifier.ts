// =============================================================
// notifier send-queue contracts + BullMQ factory
// =============================================================
//
// The `SendEmailJob` / `SendPushJob` shapes are the contract
// `processNotification` (Phase 9) was built against — Phase 10
// just plugs real BullMQ producers in behind the same interface.
//
// Tests inject in-memory stubs that satisfy `SendQueue<T>`; prod
// boots `createNotifierQueues()` against the shared Redis.

import { Queue } from "bullmq";
import type IORedis from "ioredis";

// BullMQ disallows `:` in queue names (it's the internal key separator).
export const SEND_EMAIL_QUEUE_NAME = "notifier-send-email";
export const SEND_PUSH_QUEUE_NAME = "notifier-send-push";

export interface SendEmailJob {
  deliveryId: string;
  to: string;
  /** RFC 8058 List-Unsubscribe + List-Unsubscribe-Post + List-ID. */
  headers: Record<string, string>;
  subject: string;
  html: string;
  text: string;
}

export interface SendPushJob {
  deliveryId: string;
  userId: string;
  title: string;
  body: string;
  /** Free-form per-event payload echoed back via apns/data field. */
  data: Record<string, string>;
}

export interface SendQueue<T> {
  add: (job: T) => Promise<void>;
}

export type SendEmailQueue = SendQueue<SendEmailJob>;
export type SendPushQueue = SendQueue<SendPushJob>;

// ---------------------------------------------------------------
// BullMQ factory
// ---------------------------------------------------------------
//
// `attempts: 4` matches the plan's send-retry budget; combined
// with exponential backoff that gives a worst-case window of
// ~minutes before a delivery is marked failed. `removeOnComplete`
// keeps the queue from growing unbounded while leaving enough
// recent jobs for `bull-board` to show in the dashboard.

export interface NotifierQueues {
  email: Queue<SendEmailJob>;
  push: Queue<SendPushJob>;
  emailEnqueue: SendEmailQueue;
  pushEnqueue: SendPushQueue;
  close: () => Promise<void>;
}

export function createNotifierQueues(connection: IORedis): NotifierQueues {
  const defaultJobOptions = {
    attempts: 4,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: { count: 100, age: 24 * 60 * 60 },
    removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
  };

  const email = new Queue<SendEmailJob>(SEND_EMAIL_QUEUE_NAME, {
    connection,
    defaultJobOptions,
  });
  const push = new Queue<SendPushJob>(SEND_PUSH_QUEUE_NAME, {
    connection,
    defaultJobOptions,
  });

  return {
    email,
    push,
    emailEnqueue: {
      add: async (job) => {
        await email.add("send", job, { jobId: job.deliveryId });
      },
    },
    pushEnqueue: {
      add: async (job) => {
        await push.add("send", job, { jobId: job.deliveryId });
      },
    },
    close: async () => {
      await email.close();
      await push.close();
    },
  };
}
