import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui-components/react/popover";
import { Plus } from "lucide-react";
import type {
  SubscriberListPlatform,
  SubscriberListStatusFilter,
} from "@rovenue/shared";
import { Button, buttonVariants } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";

export type SubscriberFilters = {
  status?: SubscriberListStatusFilter;
  access?: string;
  platforms?: ReadonlyArray<SubscriberListPlatform>;
  country?: string;
  ltvMin?: number;
};

type Props = {
  value: SubscriberFilters;
  onChange: (next: SubscriberFilters) => void;
  /** Active-filter count rendered next to the trigger. */
  activeCount: number;
};

const PLATFORM_ORDER: ReadonlyArray<SubscriberListPlatform> = [
  "ios",
  "android",
  "web",
];

/**
 * Inline "Add filter" popover for the subscribers page. Mirrors the
 * product catalog's filter popover: a draft state is kept while the
 * popup is open so toggling a checkbox doesn't immediately refetch
 * mid-edit, and "Apply" commits the changes to the URL search.
 */
export function SubscriberFilterPopover({
  value,
  onChange,
  activeCount,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SubscriberFilters>(value);

  const handleOpen = (next: boolean) => {
    if (next) setDraft(value);
    setOpen(next);
  };

  const apply = () => {
    // Trim empty strings so they don't pin a filter chip with no value.
    const next: SubscriberFilters = {
      status: draft.status,
      access: draft.access?.trim() || undefined,
      platforms:
        draft.platforms && draft.platforms.length > 0
          ? draft.platforms
          : undefined,
      country: draft.country?.trim().toUpperCase() || undefined,
      ltvMin:
        typeof draft.ltvMin === "number" && Number.isFinite(draft.ltvMin)
          ? draft.ltvMin
          : undefined,
    };
    onChange(next);
    setOpen(false);
  };

  const clear = () => {
    const empty: SubscriberFilters = {};
    setDraft(empty);
    onChange(empty);
    setOpen(false);
  };

  const togglePlatform = (p: SubscriberListPlatform) =>
    setDraft((d) => {
      const current = d.platforms ?? [];
      const next = current.includes(p)
        ? current.filter((x) => x !== p)
        : [...current, p];
      return { ...d, platforms: next };
    });

  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger
        className={cn(
          buttonVariants({ variant: "flat", size: "sm" }),
          activeCount > 0 && "border-rv-accent-500 text-rv-accent-500",
        )}
      >
        <Plus size={13} />
        {t("subscribers.filters.addFilter")}
        {activeCount > 0 && (
          <span className="ml-0.5 rounded-md bg-rv-accent-500/[0.15] px-1 py-0.5 font-rv-mono text-[10px] leading-none">
            {activeCount}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="w-[300px] rounded-lg border border-rv-divider-strong bg-rv-c3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            {/* Status */}
            <Section
              heading={t("subscribers.filterPopover.statusHeading")}
            >
              <div className="grid grid-cols-2 gap-1">
                <StatusButton
                  active={draft.status === undefined}
                  onClick={() => setDraft((d) => ({ ...d, status: undefined }))}
                  label={t("subscribers.scope.all")}
                />
                {(["active", "trial", "grace", "churned"] as const).map((s) => (
                  <StatusButton
                    key={s}
                    active={draft.status === s}
                    onClick={() => setDraft((d) => ({ ...d, status: s }))}
                    label={t(`subscribers.status.${s}`)}
                  />
                ))}
              </div>
            </Section>

            {/* Platforms */}
            <Section
              heading={t("subscribers.filterPopover.platformHeading")}
            >
              <div className="grid grid-cols-1 gap-1.5">
                {PLATFORM_ORDER.map((p) => (
                  <CheckRow
                    key={p}
                    label={t(`subscribers.filterPopover.platforms.${p}`)}
                    checked={draft.platforms?.includes(p) ?? false}
                    onToggle={() => togglePlatform(p)}
                  />
                ))}
              </div>
            </Section>

            {/* Entitlement / country / ltvMin */}
            <Section
              heading={t("subscribers.filterPopover.refineHeading")}
            >
              <LabelInput
                label={t("subscribers.filterPopover.entitlementLabel")}
                placeholder={t(
                  "subscribers.filterPopover.entitlementPlaceholder",
                )}
                value={draft.access ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, access: v }))}
              />
              <LabelInput
                label={t("subscribers.filterPopover.countryLabel")}
                placeholder={t(
                  "subscribers.filterPopover.countryPlaceholder",
                )}
                value={draft.country ?? ""}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, country: v.slice(0, 2) }))
                }
                maxLength={2}
              />
              <LabelInput
                label={t("subscribers.filterPopover.ltvMinLabel")}
                placeholder="0"
                inputMode="decimal"
                value={
                  typeof draft.ltvMin === "number" ? String(draft.ltvMin) : ""
                }
                onChange={(v) => {
                  if (v === "") {
                    setDraft((d) => ({ ...d, ltvMin: undefined }));
                    return;
                  }
                  const num = Number.parseFloat(v);
                  if (Number.isFinite(num) && num >= 0) {
                    setDraft((d) => ({ ...d, ltvMin: num }));
                  }
                }}
              />
            </Section>

            <div className="flex items-center justify-between gap-2 p-2.5">
              <Button variant="light" size="sm" onClick={clear} type="button">
                {t("subscribers.filterPopover.clear")}
              </Button>
              <Button
                variant="solid-primary"
                size="sm"
                onClick={apply}
                type="button"
              >
                {t("subscribers.filterPopover.apply")}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-rv-divider p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {heading}
      </div>
      {children}
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[13px] text-foreground hover:bg-rv-c4">
      <Checkbox checked={checked} onChange={onToggle} ariaLabel={label} />
      <span>{label}</span>
    </label>
  );
}

function StatusButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-[26px] rounded border text-[12px] transition",
        active
          ? "border-rv-accent-500/45 bg-rv-accent-500/15 text-[color-mix(in_srgb,var(--color-rv-accent-400)_85%,white)]"
          : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:bg-rv-c4 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function LabelInput({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: "decimal" | "text";
  maxLength?: number;
}) {
  return (
    <label className="mt-2 flex flex-col gap-1 text-[12px] text-rv-mute-600 first:mt-0">
      <span className="text-[11px] uppercase tracking-wider text-rv-mute-500">
        {label}
      </span>
      <input
        type="text"
        inputMode={inputMode}
        maxLength={maxLength}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none transition focus:border-rv-accent-500"
      />
    </label>
  );
}
