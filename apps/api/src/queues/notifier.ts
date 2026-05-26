// =============================================================
// notifier send-queue contracts
// =============================================================
//
// Phase 9.3 (`processNotification`) only depends on the *shape*
// of the send queues so it can be unit-tested against stubs.
// Phase 10 wires the real BullMQ queues that implement these
// interfaces. Keeping the contract in this file lets Phase 9
// land green without pulling BullMQ into the notifier's hot path.

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
