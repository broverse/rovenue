import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepEventsProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  existingConnection: { id: string } | null;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
}

// ---------------------------------------------------------------------------
// Event keys
// ---------------------------------------------------------------------------

export const ALL_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepEvents({
  state,
  onChange,
  onNext,
  onBack,
}: StepEventsProps) {
  const toggleEvent = (key: string) => {
    const isEnabled = state.enabledEvents.includes(key);
    const next = isEnabled
      ? state.enabledEvents.filter((k) => k !== key)
      : [...state.enabledEvents, key];
    onChange({ ...state, enabledEvents: next });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] text-rv-mute-500">
        Choose which events are forwarded to the integration.
      </p>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {ALL_EVENT_KEYS.map((key) => {
          const checked = state.enabledEvents.includes(key);
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition hover:bg-rv-c2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleEvent(key)}
                  aria-label={key}
                  className="size-4 cursor-pointer accent-rv-accent-500"
                />
                <span className="font-rv-mono text-[12px] text-rv-mute-800">
                  {key}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3",
          )}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={state.enabledEvents.length === 0}
          className={cn(
            "rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          Next
        </button>
      </div>
    </div>
  );
}
