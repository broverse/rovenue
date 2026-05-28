import { useParams } from "@tanstack/react-router";
import { useSubscriber } from "../../../lib/hooks/useSubscriber";

// Renders a single subscriber summary returned by the
// `query.subscribers.get` tool. The LLM output only carries the
// non-PII metadata (`id`, optional `plan` / `status`) — the human
// display field (`appUserId`) is fetched separately via
// `useSubscriber` so PII never enters the model context window.
export function SubscriberCard({
  id,
  plan,
  status,
}: {
  id: string;
  plan?: string;
  status?: string;
}) {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  // useSubscriber's `enabled: !!id` guard means passing an empty
  // projectId still fires the request — harmless in dev but worth
  // calling out. Future cleanup: thread an explicit enabled flag.
  const { data } = useSubscriber(projectId ?? "", id);
  const appUserId = data?.appUserId ?? id;
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <p className="text-[10px] uppercase tracking-wide text-rv-mute-500">
        {id}
      </p>
      <p className="mt-0.5 text-sm font-medium text-foreground">{appUserId}</p>
      <div className="mt-1 flex gap-3 text-rv-mute-600">
        {plan ? <span>plan: {plan}</span> : null}
        {status ? <span>status: {status}</span> : null}
      </div>
    </div>
  );
}
