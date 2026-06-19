import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, Calendar, Loader2, RefreshCw } from "lucide-react";
import type {
  RevenueEventTypeName,
  TransactionRow,
  TransactionScope,
  TransactionStoreFilter,
  TransactionsListSort,
  TransactionsStoreBreakdownResponse,
  TransactionsVolumeResponse,
} from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import {
  RevenueFlow,
  ScopeTabs,
  TransactionInspector,
  TransactionsTable,
  TxFilterBar,
  TxSortPopover,
  type StoreBreakdownRow,
  type Transaction,
  type TxScope,
  type TxStore,
  type TxType,
  type VolumeBar,
} from "../../../../components/transactions";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  buildTransactionsExportUrl,
  useProjectTransactions,
  useProjectTransactionsStoreBreakdown,
  useProjectTransactionsSync,
  useProjectTransactionsVolume,
} from "../../../../lib/hooks/useProjectTransactions";

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";

// =============================================================
// URL search-param schema
// =============================================================

const SCOPE_VALUES: ReadonlyArray<TransactionScope> = [
  "all",
  "purchase",
  "renewal",
  "refund",
  "trial",
  "failed",
];

const STORE_VALUES: ReadonlyArray<TransactionStoreFilter> = [
  "ios",
  "play",
  "stripe",
  "web",
];

const SORT_VALUES: ReadonlyArray<TransactionsListSort> = [
  "newest",
  "oldest",
  "amount_desc",
  "amount_asc",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TransactionsSearch {
  scope: TransactionScope;
  q?: string;
  stores?: TransactionStoreFilter[];
  currencies?: string[];
  amountMin?: number;
  from?: string;
  to?: string;
  sort: TransactionsListSort;
}

function parseScope(raw: unknown): TransactionScope {
  return typeof raw === "string" && (SCOPE_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as TransactionScope)
    : "all";
}

function parseSort(raw: unknown): TransactionsListSort {
  return typeof raw === "string" && (SORT_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as TransactionsListSort)
    : "newest";
}

function parseStores(raw: unknown): TransactionStoreFilter[] | undefined {
  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const allowed = new Set(STORE_VALUES as ReadonlyArray<string>);
  const matched = candidates
    .map((s) => String(s).trim().toLowerCase())
    .filter((s): s is TransactionStoreFilter => allowed.has(s));
  return matched.length > 0 ? Array.from(new Set(matched)) : undefined;
}

function parseCurrencies(raw: unknown): string[] | undefined {
  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const matched = candidates
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => /^[A-Z]{3}$/.test(s));
  return matched.length > 0 ? Array.from(new Set(matched)) : undefined;
}

function parseAmountMin(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function parseDateBound(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : raw;
}

export const Route = createFileRoute("/_authed/projects/$projectId/transactions")({
  validateSearch: (search: Record<string, unknown>): TransactionsSearch => {
    const from = parseDateBound(search.from);
    const to = parseDateBound(search.to);
    return {
      scope: parseScope(search.scope),
      q:
        typeof search.q === "string" && search.q.length > 0 ? search.q : undefined,
      stores: parseStores(search.stores),
      currencies: parseCurrencies(search.currencies),
      amountMin: parseAmountMin(search.amountMin),
      from: from && to && from > to ? undefined : from,
      to: from && to && from > to ? undefined : to,
      sort: parseSort(search.sort),
    };
  },
  component: TransactionsRoute,
});

function TransactionsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/transactions",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <TransactionsPage projectId={projectId} />;
}

// =============================================================
// Adapters — wire shape → UI Transaction
// =============================================================

const TYPE_MAP: Record<RevenueEventTypeName, TxType> = {
  INITIAL: "purchase",
  RENEWAL: "renewal",
  TRIAL_CONVERSION: "trial",
  CANCELLATION: "renewal",
  REFUND: "refund",
  REACTIVATION: "purchase",
  CREDIT_PURCHASE: "credit",
};

const STORE_MAP: Record<string, TxStore> = {
  APP_STORE: "ios",
  APPLE: "ios",
  IOS: "ios",
  PLAY_STORE: "play",
  GOOGLE: "play",
  PLAY: "play",
  STRIPE: "stripe",
  WEB: "web",
  MANUAL: "manual",
};

function mapStore(raw: string): TxStore {
  const key = raw.toUpperCase();
  return STORE_MAP[key] ?? "web";
}

const STORE_METHOD: Record<TxStore, string> = {
  ios: "App Store",
  play: "Google Play",
  stripe: "Stripe",
  web: "Web",
  manual: "Manual",
};

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffMs = t - nowMs;
  const absMin = Math.abs(diffMs) / 60_000;
  if (absMin < 1) return RELATIVE_FORMAT.format(Math.round(diffMs / 1000), "second");
  if (absMin < 60) return RELATIVE_FORMAT.format(Math.round(diffMs / 60_000), "minute");
  if (absMin < 60 * 24) return RELATIVE_FORMAT.format(Math.round(diffMs / 3_600_000), "hour");
  return RELATIVE_FORMAT.format(Math.round(diffMs / 86_400_000), "day");
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function toUiTransaction(row: TransactionRow, nowMs: number): Transaction {
  const gross = Number(row.amountUsd);
  const store = mapStore(row.store);
  return {
    id: row.id,
    type: TYPE_MAP[row.type] ?? "purchase",
    sub: shortId(row.purchaseId),
    user: shortId(row.subscriberId),
    product: row.productName ?? row.productIdentifier ?? row.productId,
    store,
    gross: Number.isFinite(gross) ? gross : 0,
    fee: 0,
    tax: 0,
    net: Number.isFinite(gross) ? gross : 0,
    currency: row.currency,
    country: "—",
    at: formatRelative(row.eventDate, nowMs),
    status: "paid",
    method: STORE_METHOD[store],
    subscriberId: row.subscriberId,
    purchaseId: row.purchaseId,
  };
}

function toVolumeBars(
  response: TransactionsVolumeResponse | undefined,
): ReadonlyArray<VolumeBar> | undefined {
  if (!response || response.points.length === 0) return undefined;
  const last = response.points.length - 1;
  return response.points.map((p, i) => ({
    day: i,
    purchases: p.purchases,
    renewals: p.renewals,
    refunds: p.refunds,
    today: i === last,
  }));
}

const USD_INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const USD_K = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function formatUsd(value: number): string {
  return `$${USD_INT.format(Math.round(value))}`;
}

function formatFeeShort(value: number): string {
  if (value >= 10_000) return `$${USD_K.format(value / 1000)}k`;
  return `$${USD_INT.format(Math.round(value))}`;
}

function toStoreBreakdownRows(
  response: TransactionsStoreBreakdownResponse | undefined,
): ReadonlyArray<StoreBreakdownRow> | undefined {
  if (!response || response.rows.length === 0) return undefined;
  return response.rows.map((r) => {
    const store = mapStore(r.store);
    const feeUsd = Number(r.estimatedFeeUsd);
    const isSelfBilled = r.estimatedFeePct === 0;
    return {
      store,
      revenue: formatUsd(Number(r.grossUsd)),
      fee: isSelfBilled ? null : formatFeeShort(feeUsd),
      feePercent: isSelfBilled ? null : `${r.estimatedFeePct.toFixed(1)}%`,
      share: `${r.pct.toFixed(1)}%`,
    };
  });
}

// =============================================================
// Page
// =============================================================

const PAGE_LIMIT = 50;

function TransactionsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const {
    scope,
    q: urlQ,
    stores,
    currencies,
    amountMin,
    from,
    to,
    sort,
  } = search;

  // Cursor stack: index 0 is the first page (no cursor), every
  // subsequent entry holds the cursor that opens that page.
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const pageIndex = cursorStack.length - 1;
  const activeCursor = cursorStack[pageIndex];

  // Local-mirror search input for responsive typing; debounced
  // into the URL.
  const [searchInput, setSearchInput] = useState(urlQ ?? "");
  useEffect(() => {
    setSearchInput(urlQ ?? "");
  }, [urlQ]);
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim();
      if ((next || undefined) === urlQ) return;
      setCursorStack([undefined]);
      void navigate({
        search: (prev) => ({ ...prev, q: next.length > 0 ? next : undefined }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, urlQ, navigate]);

  // Any change to filters/scope/sort resets the cursor stack.
  const filterKey = JSON.stringify({
    scope,
    urlQ,
    stores,
    currencies,
    amountMin,
    from,
    to,
    sort,
  });
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      setCursorStack([undefined]);
    }
  }, [filterKey]);

  const list = useProjectTransactions({
    projectId,
    scope,
    sort,
    cursor: activeCursor ?? null,
    limit: PAGE_LIMIT,
    q: urlQ,
    stores,
    currencies,
    amountMin,
    from,
    to,
  });
  const volume = useProjectTransactionsVolume({ projectId });
  const breakdown = useProjectTransactionsStoreBreakdown({ projectId });
  const sync = useProjectTransactionsSync(projectId);

  const nowMs = useMemo(() => Date.now(), [list.data, list.dataUpdatedAt]);

  const transactions = useMemo<ReadonlyArray<Transaction>>(() => {
    if (!list.data) return [];
    return list.data.rows.map((r) => toUiTransaction(r, nowMs));
  }, [list.data, nowMs]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const selected = useMemo<Transaction | null>(() => {
    if (transactions.length === 0) return null;
    if (selectedId) {
      const hit = transactions.find((tx) => tx.id === selectedId);
      if (hit) return hit;
    }
    return transactions[0] ?? null;
  }, [transactions, selectedId]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (transactions.length === 0) return;
    if (transactions.every((tx) => selectedIds.has(tx.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(transactions.map((tx) => tx.id)));
    }
  };

  // KPI numbers
  const breakdownTotal = breakdown.data ? Number(breakdown.data.totalUsd) : null;
  const breakdownRefunds = breakdown.data ? Number(breakdown.data.refundsUsd) : null;
  const breakdownFees = breakdown.data ? Number(breakdown.data.estimatedFeesUsd) : null;
  const breakdownNet =
    breakdownTotal !== null && breakdownFees !== null && breakdownRefunds !== null
      ? breakdownTotal - breakdownFees - breakdownRefunds
      : null;
  const refundEventCount = useMemo(() => {
    if (!volume.data) return null;
    return volume.data.points.reduce((a, p) => a + p.refunds, 0);
  }, [volume.data]);

  const grossLabel = breakdownTotal !== null ? formatUsd(breakdownTotal) : "—";

  const realVolume = toVolumeBars(volume.data);
  const realBreakdown = toStoreBreakdownRows(breakdown.data);

  const flowTotals = breakdown.data
    ? {
        gross: grossLabel,
        fees: breakdownFees !== null ? formatUsd(breakdownFees) : undefined,
        refunds: breakdownRefunds !== null ? formatUsd(breakdownRefunds) : undefined,
        net: breakdownNet !== null ? formatUsd(breakdownNet) : undefined,
        eventCount: breakdown.data.eventCount,
        estimatedFeePct: breakdown.data.estimatedFeePct,
        refundsPct:
          breakdownTotal && breakdownTotal > 0 && breakdownRefunds !== null
            ? Math.round((breakdownRefunds / breakdownTotal) * 1000) / 10
            : 0,
        deltaPct: breakdown.data.deltaPct,
        lastSyncMs: breakdown.dataUpdatedAt,
      }
    : undefined;

  // Pagination
  const canPrev = pageIndex > 0;
  const canNext = Boolean(list.data?.nextCursor);
  const onPrev = () => {
    if (!canPrev) return;
    setCursorStack((s) => s.slice(0, -1));
  };
  const onNext = () => {
    if (!canNext || !list.data?.nextCursor) return;
    setCursorStack((s) => [...s, list.data!.nextCursor!]);
  };

  // Filter mutators — all collapse the cursor stack on change so
  // the user lands back on page 1.
  const setScope = (next: TxScope) => {
    setCursorStack([undefined]);
    void navigate({ search: (prev) => ({ ...prev, scope: next }), replace: false });
  };
  const setStores = (next: ReadonlyArray<TransactionStoreFilter>) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        stores: next.length > 0 ? [...next] : undefined,
      }),
      replace: false,
    });
  const setCurrencies = (next: ReadonlyArray<string>) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        currencies: next.length > 0 ? [...next] : undefined,
      }),
      replace: false,
    });
  const setAmountMin = (next: number | undefined) =>
    void navigate({
      search: (prev) => ({ ...prev, amountMin: next }),
      replace: false,
    });
  const setSort = (next: TransactionsListSort) =>
    void navigate({
      search: (prev) => ({ ...prev, sort: next }),
      replace: false,
    });
  const clearAll = () =>
    void navigate({
      search: (prev) => ({
        ...prev,
        q: undefined,
        stores: undefined,
        currencies: undefined,
        amountMin: undefined,
        from: undefined,
        to: undefined,
      }),
      replace: false,
    });

  const handleExport = () => {
    const url = buildTransactionsExportUrl(API_BASE_URL, {
      projectId,
      scope,
      sort,
      q: urlQ,
      stores,
      currencies,
      amountMin,
      from,
      to,
    });
    // Use a hidden anchor so the auth cookies ride along with the
    // request (we have credentials: "include" on api(), but a
    // direct navigation matches the dashboard's cross-origin
    // cookie setup too).
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleSync = () => {
    if (sync.isPending) return;
    sync.mutate();
  };

  const syncLabel = sync.isPending
    ? t("transactions.syncStatus.syncing")
    : sync.data
      ? t("transactions.syncStatus.synced", {
          pending: sync.data.pendingOutbox.toLocaleString(),
        })
      : sync.error
        ? t("transactions.syncStatus.syncFailed")
        : t("transactions.actions.syncStores");

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("transactions.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
            {t("transactions.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm" onClick={handleSync} disabled={sync.isPending}>
            {sync.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {syncLabel}
          </Button>
          <Button variant="flat" size="sm" onClick={handleExport}>
            <ArrowUpDown size={13} />
            {t("transactions.actions.exportCsv")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("transactions.kpi.gross28d")}
          value={grossLabel}
          description={
            breakdown.data && breakdown.data.deltaPct !== null
              ? t(
                  breakdown.data.deltaPct >= 0
                    ? "transactions.kpi.grossDeltaUp"
                    : "transactions.kpi.grossDeltaDown",
                  { percent: Math.abs(breakdown.data.deltaPct).toFixed(1) },
                )
              : t("transactions.kpi.grossDeltaFlat")
          }
          descriptionTone={
            breakdown.data && breakdown.data.deltaPct !== null
              ? breakdown.data.deltaPct >= 0
                ? "success"
                : "danger"
              : undefined
          }
        />
        <StatCard
          label={t("transactions.kpi.net28d")}
          value={
            breakdownNet !== null ? (
              formatUsd(breakdownNet)
            ) : (
              <span className="text-rv-mute-500">—</span>
            )
          }
          description={t("transactions.kpi.netDescription")}
        />
        <StatCard
          label={t("transactions.kpi.refunds")}
          value={
            breakdownRefunds !== null ? (
              <span className="text-rv-danger">{formatUsd(breakdownRefunds)}</span>
            ) : (
              <span className="text-rv-mute-500">—</span>
            )
          }
          description={
            refundEventCount !== null
              ? t("transactions.kpi.refundsCount", {
                  count: refundEventCount.toLocaleString(),
                })
              : t("transactions.kpi.refundsDescription")
          }
        />
        <StatCard
          label={t("transactions.kpi.feesLabel")}
          value={
            breakdownFees !== null ? (
              formatUsd(breakdownFees)
            ) : (
              <span className="text-rv-mute-500">—</span>
            )
          }
          description={
            breakdown.data
              ? t("transactions.kpi.feesDescription", {
                  percent: breakdown.data.estimatedFeePct.toFixed(1),
                })
              : t("transactions.kpi.feesDescriptionAwaiting")
          }
        />
      </div>

      <RevenueFlow
        totals={flowTotals}
        volume={realVolume}
        storeRows={realBreakdown}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} />
        <div className="ml-auto flex gap-1.5">
          <Button variant="light" size="sm" disabled>
            <Calendar size={13} />
            {t("transactions.actions.lastRange")}
          </Button>
          <TxSortPopover value={sort} onChange={setSort} />
        </div>
      </div>

      <TxFilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        stores={stores ?? []}
        onStoresChange={setStores}
        currencies={currencies ?? []}
        onCurrenciesChange={setCurrencies}
        amountMin={amountMin}
        onAmountMinChange={setAmountMin}
        visible={transactions.length}
        total={transactions.length + (canNext ? 1 : 0)}
        onClearAll={clearAll}
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0">
          {transactions.length === 0 && !list.isLoading ? (
            <div className="rounded-lg border border-rv-divider bg-rv-c1 px-6 py-12 text-center text-[13px] text-rv-mute-500">
              {t("transactions.empty")}
            </div>
          ) : (
            <TransactionsTable
              transactions={transactions}
              selectedIds={selectedIds}
              activeId={selected?.id ?? null}
              page={pageIndex + 1}
              canPrev={canPrev}
              canNext={canNext}
              onPrev={onPrev}
              onNext={onNext}
              isLoading={list.isFetching}
              onToggleSelect={toggleOne}
              onToggleSelectAll={toggleAll}
              onOpen={setSelectedId}
            />
          )}
        </div>
        {selected ? <TransactionInspector tx={selected} /> : null}
      </div>
    </>
  );
}
