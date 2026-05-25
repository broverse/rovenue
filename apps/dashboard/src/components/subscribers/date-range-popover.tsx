import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui-components/react/popover";
import { Calendar, ChevronDown, X } from "lucide-react";
import { Button, buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

export type DateRangeValue = {
  /** ISO date `YYYY-MM-DD` or null when unset. */
  from: string | null;
  /** ISO date `YYYY-MM-DD` or null when unset. */
  to: string | null;
};

export type DateRangePreset = 7 | 14 | 28 | 90;

type Props = {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
};

const PRESETS: ReadonlyArray<DateRangePreset> = [7, 14, 28, 90];

function todayUtcISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDaysISO(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Returns the preset (in days) matching `value` exactly, else null. */
function matchPreset(value: DateRangeValue): DateRangePreset | null {
  if (!value.from || !value.to) return null;
  if (value.to !== todayUtcISO()) return null;
  for (const days of PRESETS) {
    if (value.from === shiftDaysISO(days - 1)) return days;
  }
  return null;
}

/**
 * Toolbar control for the subscribers list date filter. Surfaces
 * preset windows (7 / 14 / 28 / 90 days) plus a free-form "Custom
 * range" with two date inputs. The trigger label reflects the
 * currently applied range — empty range falls back to "All time".
 */
export function DateRangePopover({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.from ?? "");
  const [draftTo, setDraftTo] = useState(value.to ?? "");

  const handleOpen = (next: boolean) => {
    if (next) {
      setDraftFrom(value.from ?? "");
      setDraftTo(value.to ?? "");
    }
    setOpen(next);
  };

  const applyPreset = (days: DateRangePreset) => {
    onChange({ from: shiftDaysISO(days - 1), to: todayUtcISO() });
    setOpen(false);
  };

  const applyCustom = () => {
    const from = draftFrom || null;
    const to = draftTo || null;
    if (from && to && from > to) {
      // UI bound to native HTML constraints below — defensive no-op
      // here so accidentally inverted inputs don't write garbage.
      return;
    }
    onChange({ from, to });
    setOpen(false);
  };

  const clear = () => {
    onChange({ from: null, to: null });
    setDraftFrom("");
    setDraftTo("");
    setOpen(false);
  };

  const activePreset = matchPreset(value);
  const isActive = Boolean(value.from || value.to);

  let label: string;
  if (activePreset) {
    label = t("subscribers.dateRange.lastNd", { days: activePreset });
  } else if (value.from && value.to) {
    label = t("subscribers.dateRange.customRange", {
      from: value.from,
      to: value.to,
    });
  } else if (value.from) {
    label = t("subscribers.dateRange.sinceX", { date: value.from });
  } else if (value.to) {
    label = t("subscribers.dateRange.untilX", { date: value.to });
  } else {
    label = t("subscribers.dateRange.allTime");
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger
        className={cn(
          buttonVariants({ variant: "light", size: "sm" }),
          isActive && "border-rv-accent-500 text-rv-accent-500",
        )}
      >
        <Calendar size={13} />
        <span>{label}</span>
        {isActive ? (
          // Clicking the X clears the filter without opening the
          // popover — `stopPropagation` keeps the click from
          // toggling the trigger.
          <button
            type="button"
            aria-label={t("subscribers.dateRange.clear")}
            className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              clear();
            }}
          >
            <X size={10} />
          </button>
        ) : (
          <ChevronDown size={11} className="opacity-60" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="w-[280px] rounded-lg border border-rv-divider-strong bg-rv-c3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            <div className="border-b border-rv-divider p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("subscribers.dateRange.presetsHeading")}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {PRESETS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => applyPreset(days)}
                    className={cn(
                      "h-[26px] rounded border text-[12px] transition",
                      activePreset === days
                        ? "border-rv-accent-500/45 bg-rv-accent-500/15 text-[color-mix(in_srgb,var(--color-rv-accent-400)_85%,white)]"
                        : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c4 hover:text-foreground",
                    )}
                  >
                    {t("subscribers.dateRange.lastNd", { days })}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-rv-divider p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("subscribers.dateRange.customHeading")}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <DateInput
                  label={t("subscribers.dateRange.from")}
                  value={draftFrom}
                  max={draftTo || undefined}
                  onChange={setDraftFrom}
                />
                <DateInput
                  label={t("subscribers.dateRange.to")}
                  value={draftTo}
                  min={draftFrom || undefined}
                  onChange={setDraftTo}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 p-2.5">
              <Button variant="light" size="sm" onClick={clear} type="button">
                {t("subscribers.dateRange.clear")}
              </Button>
              <Button
                variant="solid-primary"
                size="sm"
                onClick={applyCustom}
                type="button"
              >
                {t("subscribers.dateRange.apply")}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DateInput({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  min?: string;
  max?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-rv-mute-500">
        {label}
      </span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none transition focus:border-rv-accent-500 [color-scheme:dark]"
      />
    </label>
  );
}
