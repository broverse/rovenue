import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TransactionStoreFilter } from "@rovenue/shared";
import { FilterPill } from "../subscribers/filter-pill";
import { cn } from "../../lib/cn";

type Props = {
  search: string;
  onSearchChange: (next: string) => void;
  stores: ReadonlyArray<TransactionStoreFilter>;
  onStoresChange: (next: ReadonlyArray<TransactionStoreFilter>) => void;
  currencies: ReadonlyArray<string>;
  onCurrenciesChange: (next: ReadonlyArray<string>) => void;
  amountMin: number | undefined;
  onAmountMinChange: (next: number | undefined) => void;
  visible: number;
  total: number;
  onClearAll?: () => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
};

const STORE_OPTIONS: ReadonlyArray<TransactionStoreFilter> = [
  "ios",
  "play",
  "stripe",
  "web",
];

export function TxFilterBar({
  search,
  onSearchChange,
  stores,
  onStoresChange,
  currencies,
  onCurrenciesChange,
  amountMin,
  onAmountMinChange,
  visible,
  total,
  onClearAll,
  searchInputRef,
}: Props) {
  const { t } = useTranslation();
  const activeCount =
    (stores.length > 0 ? 1 : 0) +
    (currencies.length > 0 ? 1 : 0) +
    (typeof amountMin === "number" ? 1 : 0);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5">
      <label className="flex h-[26px] min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
        <Search size={12} className="text-rv-mute-500" />
        <input
          ref={searchInputRef}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("transactions.filters.searchPlaceholder")}
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label={t("transactions.filters.clearSearch")}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
          >
            <X size={11} />
          </button>
        ) : null}
      </label>

      <AmountFilter value={amountMin} onChange={onAmountMinChange} />
      <StoreFilter value={stores} onChange={onStoresChange} options={STORE_OPTIONS} />
      <CurrencyFilter value={currencies} onChange={onCurrenciesChange} />

      {activeCount > 0 && onClearAll ? (
        <FilterPill onClick={onClearAll}>
          <X size={10} />
          {t("transactions.filters.clearAll")}
        </FilterPill>
      ) : null}

      <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
        {t("transactions.filters.showing", {
          visible: visible.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </span>
    </div>
  );
}

// -------------------------------------------------------------
// Lightweight inline popovers — each one is a self-contained
// button + click-outside dropdown. We avoid pulling in radix for
// such a thin surface.
// -------------------------------------------------------------

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

function AmountFilter({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
  const ref = useClickAway(() => setOpen(false));

  useEffect(() => {
    setDraft(value !== undefined ? String(value) : "");
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onChange(undefined);
    } else {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <FilterPill active={typeof value === "number"} onClick={() => setOpen((o) => !o)}>
        {t("transactions.filters.amount")}{" "}
        <span className="font-medium text-foreground">
          {typeof value === "number" ? `≥ $${value}` : t("transactions.filters.any")}
        </span>
        {typeof value === "number" ? (
          <button
            type="button"
            aria-label={t("transactions.filters.clear")}
            onClick={(e) => {
              e.stopPropagation();
              onChange(undefined);
            }}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
          >
            <X size={10} />
          </button>
        ) : null}
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[220px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          <label className="block text-[10px] uppercase tracking-wider text-rv-mute-500">
            {t("transactions.filters.amountMinLabel")}
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="0.00"
            className="mt-1.5 h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="cursor-pointer text-[11px] text-rv-mute-500 hover:text-foreground"
            >
              {t("transactions.filters.clear")}
            </button>
            <button
              type="button"
              onClick={commit}
              className="cursor-pointer rounded-md bg-rv-accent-500 px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
            >
              {t("transactions.filters.apply")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StoreFilter({
  value,
  onChange,
  options,
}: {
  value: ReadonlyArray<TransactionStoreFilter>;
  onChange: (next: ReadonlyArray<TransactionStoreFilter>) => void;
  options: ReadonlyArray<TransactionStoreFilter>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const toggle = (s: TransactionStoreFilter) => {
    onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  };
  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("transactions.filters.store")}{" "}
        <span className="font-medium text-foreground">
          {value.length === 0
            ? t("transactions.filters.any")
            : value.length === 1
              ? t(`transactions.storeFilter.${value[0]}`)
              : t("transactions.filters.nSelected", { count: value.length })}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[180px] rounded-md border border-rv-divider bg-rv-c1 p-1 shadow-lg">
          {options.map((s) => {
            const checked = value.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggle(s)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[12px] hover:bg-rv-c2",
                  checked && "text-foreground",
                )}
              >
                <span>{t(`transactions.storeFilter.${s}`)}</span>
                <span
                  className={cn(
                    "h-3 w-3 rounded-sm border",
                    checked
                      ? "border-rv-accent-500 bg-rv-accent-500"
                      : "border-rv-divider",
                  )}
                />
              </button>
            );
          })}
          {value.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full cursor-pointer rounded px-2 py-1 text-[11px] text-rv-mute-500 hover:bg-rv-c2 hover:text-foreground"
            >
              {t("transactions.filters.clear")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CurrencyFilter({
  value,
  onChange,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<string>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value.join(", "));
  const ref = useClickAway(() => setOpen(false));

  useEffect(() => {
    setDraft(value.join(", "));
  }, [value]);

  const commit = () => {
    const parsed = draft
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{3}$/.test(s));
    onChange(Array.from(new Set(parsed)));
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("transactions.filters.currency")}{" "}
        <span className="font-medium text-foreground">
          {value.length === 0
            ? t("transactions.filters.any")
            : value.join(", ")}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[220px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          <label className="block text-[10px] uppercase tracking-wider text-rv-mute-500">
            {t("transactions.filters.currencyLabel")}
          </label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            placeholder="USD, EUR"
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setOpen(false);
            }}
            className="mt-1.5 h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] uppercase outline-none focus:border-rv-accent-500"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              className="cursor-pointer text-[11px] text-rv-mute-500 hover:text-foreground"
            >
              {t("transactions.filters.clear")}
            </button>
            <button
              type="button"
              onClick={commit}
              className="cursor-pointer rounded-md bg-rv-accent-500 px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
            >
              {t("transactions.filters.apply")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
