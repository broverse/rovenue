import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui-components/react/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import type { SubscriberListSortMode } from "@rovenue/shared";
import { buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";

type Props = {
  value: SubscriberListSortMode;
  onChange: (next: SubscriberListSortMode) => void;
};

const OPTIONS: ReadonlyArray<SubscriberListSortMode> = [
  "last_activity",
  "created",
  "ltv",
  "purchases",
];

/**
 * Single-select dropdown bound to the URL `sort` param. Switching
 * the mode invalidates the keyset cursor server-side, so picking a
 * new sort resets the list to its first page automatically.
 */
export function SortPopover({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(buttonVariants({ variant: "light", size: "sm" }))}
      >
        <ChevronsUpDown size={13} />
        {t("subscribers.sort.label", {
          mode: t(`subscribers.sort.modes.${value}`),
        })}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            {OPTIONS.map((mode) => {
              const active = mode === value;
              return (
                <Popover.Close
                  key={mode}
                  render={
                    <button
                      type="button"
                      onClick={() => onChange(mode)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition",
                        active
                          ? "text-[color-mix(in_srgb,var(--color-rv-accent-400)_85%,white)]"
                          : "text-rv-mute-700 hover:bg-rv-c4 hover:text-foreground",
                      )}
                    >
                      <span>{t(`subscribers.sort.modes.${mode}`)}</span>
                      {active && <Check size={12} />}
                    </button>
                  }
                />
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
