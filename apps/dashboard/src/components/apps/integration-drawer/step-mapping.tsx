import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepMappingProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  existingConnection: { id: string } | null;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepMapping({ state, onChange, onNext, onBack }: StepMappingProps) {
  const [accordionOpen, setAccordionOpen] = useState(false);

  const updateMapping = (eventKey: string, eventName: string) => {
    const next: DrawerState["eventMapping"] = {
      ...state.eventMapping,
      [eventKey]: {
        ...state.eventMapping[eventKey],
        eventName: eventName || undefined,
      },
    };
    onChange({ ...state, eventMapping: next });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] text-rv-mute-500">
        By default the integration uses Rovenue's standard event names. You can
        override them below.
      </p>

      {/* Accordion trigger */}
      <button
        type="button"
        onClick={() => setAccordionOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12px] font-medium text-foreground transition hover:bg-rv-c3"
        aria-expanded={accordionOpen}
      >
        Advanced: customize event names
        <ChevronDown
          size={14}
          className={cn(
            "transition-transform duration-150",
            accordionOpen ? "rotate-180" : "",
          )}
        />
      </button>

      {/* Accordion body */}
      {accordionOpen && state.enabledEvents.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {state.enabledEvents.map((key) => (
            <li key={key} className="flex flex-col gap-1">
              <label
                htmlFor={`mapping-${key}`}
                className="font-rv-mono text-[11px] text-rv-mute-500"
              >
                {key}
              </label>
              <input
                id={`mapping-${key}`}
                type="text"
                placeholder="(default)"
                value={state.eventMapping[key]?.eventName ?? ""}
                onChange={(e) => updateMapping(key, e.target.value)}
                aria-label={`Mapping for ${key}`}
                className={cn(
                  "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
                  "focus:border-rv-accent-500 focus:outline-none",
                )}
              />
            </li>
          ))}
        </ul>
      )}

      {accordionOpen && state.enabledEvents.length === 0 && (
        <p className="text-[12px] text-rv-mute-500">
          No events selected. Go back and select events first.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600"
        >
          Next
        </button>
      </div>
    </div>
  );
}
