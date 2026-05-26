import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubscriptionStoreCode } from "@rovenue/shared";
import { FilterPill } from "../subscribers/filter-pill";
import { cn } from "../../lib/cn";

// Public value object — owned by the route, passed in.
export interface SubscriptionsFilterValue {
  search: string;
  store: ReadonlyArray<SubscriptionStoreCode>;
  productId: ReadonlyArray<string>;
  autoRenew: boolean | undefined;
  isTrial: boolean | undefined;
  isIntro: boolean | undefined;
  hasIssue: boolean;
  purchasedFrom: string | undefined;
  purchasedTo: string | undefined;
  expiresFrom: string | undefined;
  expiresTo: string | undefined;
}

export interface ProductOption {
  id: string;
  label: string;
}

type Props = {
  value: SubscriptionsFilterValue;
  onChange: (next: SubscriptionsFilterValue) => void;
  products: ReadonlyArray<ProductOption>;
  visible: number;
  total: number;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
};

const STORE_OPTIONS: ReadonlyArray<SubscriptionStoreCode> = [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "MANUAL",
];

export function FilterToolbar({
  value,
  onChange,
  products,
  visible,
  total,
  searchInputRef,
}: Props) {
  const { t } = useTranslation();
  const hasAny =
    value.search.length > 0 ||
    value.store.length > 0 ||
    value.productId.length > 0 ||
    value.autoRenew !== undefined ||
    value.isTrial !== undefined ||
    value.isIntro !== undefined ||
    value.hasIssue ||
    Boolean(
      value.purchasedFrom ||
        value.purchasedTo ||
        value.expiresFrom ||
        value.expiresTo,
    );

  const patch = (p: Partial<SubscriptionsFilterValue>) =>
    onChange({ ...value, ...p });

  const clearAll = () =>
    onChange({
      search: "",
      store: [],
      productId: [],
      autoRenew: undefined,
      isTrial: undefined,
      isIntro: undefined,
      hasIssue: false,
      purchasedFrom: undefined,
      purchasedTo: undefined,
      expiresFrom: undefined,
      expiresTo: undefined,
    });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5">
      <label className="flex h-[26px] min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
        <Search size={12} className="text-rv-mute-500" />
        <input
          ref={searchInputRef}
          value={value.search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder={t("subscriptions.filters.searchPlaceholder")}
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
        />
        {value.search ? (
          <button
            type="button"
            onClick={() => patch({ search: "" })}
            aria-label={t("subscriptions.filters.clearSearch")}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
          >
            <X size={11} />
          </button>
        ) : null}
      </label>

      <StoreFilter value={value.store} onChange={(store) => patch({ store })} />
      <ProductFilter
        value={value.productId}
        onChange={(productId) => patch({ productId })}
        options={products}
      />
      <AutoRenewFilter
        value={value.autoRenew}
        onChange={(autoRenew) => patch({ autoRenew })}
      />
      <MoreFiltersPopover value={value} onChange={onChange} />

      {hasAny ? (
        <FilterPill onClick={clearAll}>
          <X size={10} />
          {t("subscriptions.filters.clearAll")}
        </FilterPill>
      ) : null}

      <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
        {t("subscriptions.filters.showing", {
          visible: visible.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// click-away helper (mirrors transactions module)
// ---------------------------------------------------------------------------

function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onAway]);
  return ref;
}

// ---------------------------------------------------------------------------
// Individual filter pieces
// ---------------------------------------------------------------------------

function StoreFilter({
  value,
  onChange,
}: {
  value: ReadonlyArray<SubscriptionStoreCode>;
  onChange: (next: ReadonlyArray<SubscriptionStoreCode>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const toggle = (s: SubscriptionStoreCode) =>
    onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.store")}{" "}
        <span className="font-medium text-foreground">
          {value.length > 0 ? value.length : t("subscriptions.filters.any")}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[200px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          {STORE_OPTIONS.map((s) => (
            <label
              key={s}
              className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[12px] hover:bg-rv-c2"
            >
              <input
                type="checkbox"
                checked={value.includes(s)}
                onChange={() => toggle(s)}
              />
              {t(`subscriptions.filters.storeLabels.${s}`)}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductFilter({
  value,
  onChange,
  options,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<string>) => void;
  options: ReadonlyArray<ProductOption>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useClickAway(() => setOpen(false));
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.product")}{" "}
        <span className="font-medium text-foreground">
          {value.length > 0 ? value.length : t("subscriptions.filters.any")}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[260px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("subscriptions.filters.productSearch")}
            className="mb-1.5 h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
          />
          <div className="max-h-[200px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-rv-mute-500">
                {t("subscriptions.filters.noResults")}
              </div>
            ) : (
              filtered.map((opt) => (
                <label
                  key={opt.id}
                  className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[12px] hover:bg-rv-c2"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(opt.id)}
                    onChange={() => toggle(opt.id)}
                  />
                  <span className="truncate">{opt.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AutoRenewFilter({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}) {
  const { t } = useTranslation();
  const next = () => {
    if (value === undefined) onChange(true);
    else if (value === true) onChange(false);
    else onChange(undefined);
  };
  return (
    <FilterPill active={value !== undefined} onClick={next}>
      {t("subscriptions.filters.autoRenew")}{" "}
      <span className="font-medium text-foreground">
        {value === undefined
          ? t("subscriptions.filters.any")
          : value
            ? t("subscriptions.filters.on")
            : t("subscriptions.filters.off")}
      </span>
    </FilterPill>
  );
}

function MoreFiltersPopover({
  value,
  onChange,
}: {
  value: SubscriptionsFilterValue;
  onChange: (next: SubscriptionsFilterValue) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const activeCount =
    (value.isTrial !== undefined ? 1 : 0) +
    (value.isIntro !== undefined ? 1 : 0) +
    (value.hasIssue ? 1 : 0) +
    (value.purchasedFrom || value.purchasedTo ? 1 : 0) +
    (value.expiresFrom || value.expiresTo ? 1 : 0);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={activeCount > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.more")}{" "}
        {activeCount > 0 ? (
          <span className="font-medium text-foreground">{activeCount}</span>
        ) : null}
      </FilterPill>
      {open ? (
        <div className="absolute right-0 top-full z-10 mt-1 w-[320px] rounded-md border border-rv-divider bg-rv-c1 p-3 shadow-lg">
          <FlagToggle
            label={t("subscriptions.filters.isTrial")}
            value={value.isTrial}
            onChange={(v) => onChange({ ...value, isTrial: v })}
          />
          <FlagToggle
            label={t("subscriptions.filters.isIntro")}
            value={value.isIntro}
            onChange={(v) => onChange({ ...value, isIntro: v })}
          />
          <FlagToggle
            label={t("subscriptions.filters.hasIssue")}
            value={value.hasIssue ? true : undefined}
            onChange={(v) => onChange({ ...value, hasIssue: v === true })}
          />
          <hr className="my-2 border-rv-divider" />
          <DateRange
            label={t("subscriptions.filters.purchasedRange")}
            from={value.purchasedFrom}
            to={value.purchasedTo}
            onChange={(f, t_) =>
              onChange({ ...value, purchasedFrom: f, purchasedTo: t_ })
            }
          />
          <DateRange
            label={t("subscriptions.filters.expiresRange")}
            from={value.expiresFrom}
            to={value.expiresTo}
            onChange={(f, t_) =>
              onChange({ ...value, expiresFrom: f, expiresTo: t_ })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function FlagToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px]">
      <span>{label}</span>
      <div className="flex gap-1">
        {(["any", true, false] as const).map((v) => {
          const target = v === "any" ? undefined : v;
          const active = value === target;
          return (
            <button
              key={String(v)}
              type="button"
              onClick={() => onChange(target)}
              className={cn(
                "h-6 cursor-pointer rounded-md px-2 text-[11px]",
                active
                  ? "bg-rv-accent-500/15 text-rv-accent-400 border border-rv-accent-500/45"
                  : "bg-rv-c2 text-rv-mute-700 border border-rv-divider",
              )}
            >
              {v === "any" ? "—" : v ? "On" : "Off"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateRange({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  return (
    <div className="py-1">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange(e.target.value || undefined, to)}
          className="h-7 flex-1 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
        />
        <span className="text-rv-mute-500">–</span>
        <input
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange(from, e.target.value || undefined)}
          className="h-7 flex-1 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
        />
      </div>
    </div>
  );
}
