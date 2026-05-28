import type { ReactNode } from "react";
import { SubscriberCard } from "./subscriber-card";

// Renders the array returned by `query.subscribers.search`. We cap
// the visible list at 10 to keep the chat surface compact; the count
// of remaining results is surfaced as a small caption so the user
// can ask a follow-up to refine the query.
export function SubscriberList({
  subscribers,
}: {
  subscribers: Array<{ id: string; plan?: string; status?: string }>;
}): ReactNode {
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    return <p className="text-xs text-rv-mute-600">No subscribers match.</p>;
  }
  return (
    <div className="space-y-2">
      {subscribers.slice(0, 10).map((s) => (
        <SubscriberCard key={s.id} {...s} />
      ))}
      {subscribers.length > 10 ? (
        <p className="text-[11px] text-rv-mute-500">
          +{subscribers.length - 10} more
        </p>
      ) : null}
    </div>
  );
}
