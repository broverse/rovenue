import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, Link2 } from "lucide-react";
import type { StoreCatalogItem } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { cn } from "../../lib/cn";
import { useStoreCatalog } from "../../lib/hooks/useProjectProducts";
import { useProjectCredentials } from "../../lib/hooks/useProjectCredentials";

type ApiStore = "ios" | "android";

// ---------------------------------------------------------------------------
// Fieldset — one row per store (iOS / Android catalog pickers, Web free-text)
// ---------------------------------------------------------------------------

export function StoreIdentifiersFieldset({
  projectId,
  iosId,
  androidId,
  webId,
  androidBasePlanId,
  androidOfferId,
  onChange,
  onAndroidBasePlanIdChange,
  onAndroidOfferIdChange,
}: {
  projectId: string;
  iosId: string;
  androidId: string;
  webId: string;
  androidBasePlanId: string;
  androidOfferId: string;
  onChange: (store: "ios" | "android" | "web", value: string) => void;
  onAndroidBasePlanIdChange: (value: string) => void;
  onAndroidOfferIdChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const creds = useProjectCredentials(projectId);
  const c = creds.data?.credentials;
  const loading = creds.isPending;

  const idBasePlan = useId();
  const idOfferId = useId();

  return (
    <fieldset className="grid grid-cols-1 gap-2 rounded-md border border-rv-divider bg-rv-c2/50 p-3">
      <legend className="px-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("products.form.fields.storeIds")}
      </legend>
      <ApiStoreRow
        store="ios"
        label="iOS"
        projectId={projectId}
        configured={loading ? undefined : (c?.apple.configured ?? false)}
        value={iosId}
        onChange={(v) => onChange("ios", v)}
      />
      <ApiStoreRow
        store="android"
        label="Android"
        projectId={projectId}
        configured={loading ? undefined : (c?.google.configured ?? false)}
        value={androidId}
        onChange={(v) => onChange("android", v)}
      />
      <StoreRowShell label={t("products.form.storeIds.basePlanLabel", "Base plan")} htmlFor={idBasePlan}>
        <Input
          id={idBasePlan}
          mono
          value={androidBasePlanId}
          onChange={(e) => onAndroidBasePlanIdChange(e.target.value)}
          placeholder={t("products.form.storeIds.basePlanPlaceholder", "e.g. monthly")}
        />
      </StoreRowShell>
      <StoreRowShell label={t("products.form.storeIds.offerIdLabel", "Offer ID")} htmlFor={idOfferId}>
        <Input
          id={idOfferId}
          mono
          value={androidOfferId}
          onChange={(e) => onAndroidOfferIdChange(e.target.value)}
          placeholder={t("products.form.storeIds.offerIdPlaceholder", "e.g. introductory")}
        />
      </StoreRowShell>
      <p className="text-[11px] text-rv-mute-500">
        {t(
          "products.form.storeIds.androidDefaultOfferHint",
          "Optional. Default Play base plan / offer to purchase when the app doesn't pick one; blank = lowest-priced base plan.",
        )}
      </p>
      <WebStoreRow
        label="Web"
        projectId={projectId}
        configured={loading ? undefined : (c?.stripe.configured ?? false)}
        value={webId}
        onChange={(v) => onChange("web", v)}
      />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Row shell — fixed-width label column + flexible content
// ---------------------------------------------------------------------------

function StoreRowShell({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={htmlFor}
        className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
      >
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function RowMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[38px] items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-rv-mute-500">
      {children}
    </div>
  );
}

/** "Store not connected → Connect store" affordance linking to the Apps page. */
function ConnectStorePrompt({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/projects/$projectId/apps"
      params={{ projectId }}
      className={cn(
        "flex h-[38px] items-center gap-2 rounded-md border border-dashed border-rv-divider-strong bg-rv-c2/40 px-3 text-[12px] text-rv-mute-500 transition",
        "hover:border-rv-accent-500/60 hover:bg-rv-accent-500/[0.06] hover:text-rv-accent-500",
      )}
    >
      <Link2 size={13} aria-hidden />
      <span>{t("products.form.storeIds.connect", "Connect store")}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// iOS / Android — catalog-backed combobox
// ---------------------------------------------------------------------------

function ApiStoreRow({
  store,
  label,
  projectId,
  configured,
  value,
  onChange,
}: {
  store: ApiStore;
  label: string;
  projectId: string;
  /** undefined while credentials load, then the resolved boolean. */
  configured: boolean | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const catalog = useStoreCatalog(projectId, store, configured === true);

  let content: React.ReactNode;
  if (configured === undefined) {
    content = <RowMessage>{t("common.loading")}</RowMessage>;
  } else if (!configured) {
    content = <ConnectStorePrompt projectId={projectId} />;
  } else if (catalog.isLoading) {
    content = (
      <RowMessage>
        {t("products.form.storeIds.fetching", "Fetching products…")}
      </RowMessage>
    );
  } else if (catalog.isError) {
    content = (
      <Link
        to="/projects/$projectId/apps"
        params={{ projectId }}
        className="flex h-[38px] items-center rounded-md border border-rv-danger/40 bg-rv-danger/[0.06] px-3 text-[12px] text-rv-danger underline-offset-2 hover:underline"
      >
        {t("products.form.storeIds.catalogError", "Couldn't load store products — check credentials")}
      </Link>
    );
  } else {
    content = (
      <StoreCatalogCombobox
        id={fieldId}
        items={catalog.data?.items ?? []}
        value={value}
        onChange={onChange}
      />
    );
  }

  return (
    <StoreRowShell label={label} htmlFor={fieldId}>
      {content}
    </StoreRowShell>
  );
}

// ---------------------------------------------------------------------------
// Web — Stripe gate + free-text input (no store catalog API for web)
// ---------------------------------------------------------------------------

function WebStoreRow({
  label,
  projectId,
  configured,
  value,
  onChange,
}: {
  label: string;
  projectId: string;
  configured: boolean | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();

  let content: React.ReactNode;
  if (configured === undefined) {
    content = <RowMessage>{t("common.loading")}</RowMessage>;
  } else if (!configured) {
    content = <ConnectStorePrompt projectId={projectId} />;
  } else {
    content = (
      <Input
        id={fieldId}
        mono
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="price_xxx"
      />
    );
  }

  return (
    <StoreRowShell label={label} htmlFor={fieldId}>
      {content}
    </StoreRowShell>
  );
}

// ---------------------------------------------------------------------------
// StoreCatalogCombobox — searchable picker over the fetched store catalog
// ---------------------------------------------------------------------------

function StoreCatalogCombobox({
  id,
  items,
  value,
  onChange,
}: {
  id: string;
  items: ReadonlyArray<StoreCatalogItem>;
  value: string;
  onChange: (storeId: string) => void;
}) {
  const { t } = useTranslation();

  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropUp, setDropUp] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Reflect external changes (modal hydrate / reset) into the input.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Only filter once the user actually types; a freshly-opened picker shows
  // the whole catalog so the current selection can be browsed away from.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!dirty || !q) return items;
    return items.filter(
      (it) =>
        it.storeId.toLowerCase().includes(q) ||
        (it.name?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query, dirty]);

  const openPanel = () => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) setDropUp(rect.bottom > window.innerHeight * 0.6);
    setOpen(true);
  };

  const close = (revert: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    setDirty(false);
    if (revert) setQuery(value);
  };

  const select = (it: StoreCatalogItem) => {
    onChange(it.storeId);
    setQuery(it.storeId);
    close(false);
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close(true);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  useEffect(() => {
    setActiveIndex((i) =>
      filtered.length === 0 ? -1 : Math.min(Math.max(i, -1), filtered.length - 1),
    );
  }, [filtered]);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openPanel();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (open && activeIndex >= 0 && filtered[activeIndex]) {
          e.preventDefault();
          select(filtered[activeIndex]!);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          close(true);
        }
        break;
    }
  };

  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={t("products.form.storeIds.searchPlaceholder", "Select a store product…")}
          onChange={(e) => {
            setQuery(e.target.value);
            setDirty(true);
            if (!open) openPanel();
          }}
          onFocus={openPanel}
          onKeyDown={onKeyDown}
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 pr-9 py-2 pl-3 font-rv-mono text-[12px] text-foreground transition",
            "placeholder:font-sans placeholder:text-rv-mute-500 focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30",
          )}
        />
        <ChevronDown
          size={16}
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </div>

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          className={cn(
            "absolute z-50 max-h-48 w-full overflow-y-auto rounded-md border border-rv-divider-strong bg-rv-c2 py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] animate-rv-menu-in",
            dropUp ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-rv-mute-500">
              {items.length === 0
                ? t("products.form.storeIds.empty", "No products in the store catalog.")
                : t("products.form.storeIds.noMatch", "No matching products.")}
            </div>
          ) : (
            filtered.map((it, i) => {
              const selected = it.storeId === value;
              const active = i === activeIndex;
              return (
                <div
                  key={it.storeId}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  data-active={active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => select(it)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-1.5",
                    active ? "bg-rv-c4" : "hover:bg-rv-c3",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-rv-mono text-[12px] text-foreground">
                      {it.storeId}
                    </span>
                    {it.name && (
                      <span className="block truncate text-[11px] text-rv-mute-500">
                        {it.name}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-rv-mute-500">
                    {it.priceLabel ?? it.type.toLowerCase().replace("_", " ")}
                  </span>
                  {it.alreadyImported && (
                    <span className="shrink-0 rounded-full bg-rv-mute-500/[0.12] px-2 py-0.5 text-[10px] text-rv-mute-800">
                      {t("products.form.storeIds.imported", "Imported")}
                    </span>
                  )}
                  {selected && (
                    <Check size={14} aria-hidden className="shrink-0 text-rv-accent-500" />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
