-- Add a transient 'sending' state to NotificationDeliveryStatus so the
-- send-email / send-push workers can atomically single-flight-claim a
-- delivery row (queued/failed -> sending) before the transport call runs,
-- mirroring the OutgoingWebhookStatus 'DELIVERING' claim pattern. This
-- closes the concurrent-duplicate TOCTOU window the prior findDeliveryById
-- read-then-check guard left open. Placed BEFORE 'sent' for ordering.
ALTER TYPE "public"."NotificationDeliveryStatus" ADD VALUE 'sending' BEFORE 'sent';
