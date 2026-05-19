import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, Calendar, Plus, RefreshCw } from "lucide-react";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import {
  RevenueFlow,
  ScopeTabs,
  TRANSACTIONS,
  TX_TOTAL_EVENTS,
  TransactionInspector,
  TransactionsTable,
  TxFilterBar,
  type StoreBreakdownRow,
  type Transaction,
  type TxScope,
  type TxStore,
  type TxType,
  type VolumeBar,
} from "../../../../components/transactions";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useProjectTransactions,
  useProjectTransactionsStoreBreakdown,
  useProjectTransactionsVolume,
} from "../../../../lib/hooks/useProjectTransactions";
import type {
  RevenueEventTypeName,
  TransactionRow,
  TransactionsStoreBreakdownResponse,
  TransactionsVolumeResponse,
} from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/$projectId/transactions")({
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
//
// `revenue_events` doesn't carry fee / tax / country / payment-method
// today, so the fields the table renders for those columns are
// derived rather than authoritative: `fee` and `tax` default to
// zero (gross == net), `country` falls back to an em dash, and
// `method` is filled with a short store name. Lifecycle status
// is always `paid` because the table is fed off a settled-event
// ledger; failed-attempt logging will populate the other statuses
// when that pipeline lands.

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
  };
}

// -------------------------------------------------------------
// Volume + store-breakdown adapters
// -------------------------------------------------------------

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

const STORE_ROW_NAME: Record<TxStore, string> = {
  ios: "App Store",
  play: "Google Play",
  stripe: "Stripe",
  web: "Web",
};

const USD_INT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function toStoreBreakdownRows(
  response: TransactionsStoreBreakdownResponse | undefined,
): ReadonlyArray<StoreBreakdownRow> | undefined {
  if (!response || response.rows.length === 0) return undefined;
  return response.rows.map((r) => {
    const store = mapStore(r.store);
    void STORE_ROW_NAME[store];
    return {
      store,
      revenue: `$${USD_INT.format(Math.round(Number(r.grossUsd)))}`,
      fee: null,
      feePercent: null,
      share: `${r.pct.toFixed(1)}%`,
    };
  });
}

// =============================================================
// Page
// =============================================================

function TransactionsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<TxScope>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  // Live queries
  const list = useProjectTransactions({ projectId, scope });
  const volume = useProjectTransactionsVolume({ projectId });
  const breakdown = useProjectTransactionsStoreBreakdown({ projectId });

  const nowMs = useMemo(() => Date.now(), [list.data?.pageParams.length, list.dataUpdatedAt]);

  // Flatten paged results and apply the client-side free-text
  // filter against id / user / product / country / method — the
  // server only filters by scope.
  const transactions = useMemo<ReadonlyArray<Transaction>>(() => {
    const pages = list.data?.pages;
    if (!pages || pages.length === 0) return TRANSACTIONS;
    const flat = pages.flatMap((p) => p.rows.map((r) => toUiTransaction(r, nowMs)));
    if (flat.length === 0) return [];
    return flat;
  }, [list.data, nowMs]);

  const filtered = useMemo<ReadonlyArray<Transaction>>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return transactions;
    return transactions.filter((tx) => {
      const haystack = [tx.id, tx.user, tx.sub, tx.product, tx.country, tx.method]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [transactions, search]);

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
    if (filtered.length === 0) return;
    if (filtered.every((tx) => selectedIds.has(tx.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((tx) => tx.id)));
    }
  };

  // Total / KPI numbers — derive from the store-breakdown rollup
  // which already has the project-wide window total. Falls back
  // to the design-mock copy while the query is in flight.
  const breakdownTotal = breakdown.data ? Number(breakdown.data.totalUsd) : null;
  const refundsUsd = useMemo(() => {
    if (!volume.data) return null;
    return volume.data.points.reduce((a, p) => a + p.refunds, 0);
  }, [volume.data]);

  const grossLabel =
    breakdownTotal !== null
      ? `$${USD_INT.format(Math.round(breakdownTotal))}`
      : "$248,192";

  const realVolume = toVolumeBars(volume.data);
  const realBreakdown = toStoreBreakdownRows(breakdown.data);

  const totalEvents =
    list.data?.pages.reduce((a, p) => a + p.rows.length, 0) ?? TX_TOTAL_EVENTS;

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
          <Button variant="flat" size="sm" onClick={() => void list.refetch()}>
            <RefreshCw size={13} />
            {t("transactions.actions.syncStores")}
          </Button>
          <Button variant="flat" size="sm">
            <ArrowUpDown size={13} />
            {t("transactions.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("transactions.actions.issueRefund")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("transactions.kpi.gross28d")}
          value={grossLabel}
          description={t("transactions.kpi.grossDelta")}
          descriptionTone="success"
        />
        <StatCard
          label={t("transactions.kpi.net28d")}
          value={grossLabel}
          description={t("transactions.kpi.netDescription")}
        />
        <StatCard
          label={t("transactions.kpi.refunds")}
          value={
            refundsUsd !== null ? (
              <span className="text-rv-danger">{refundsUsd.toLocaleString()}</span>
            ) : (
              <span className="text-rv-danger">−$3,842.18</span>
            )
          }
          description={t("transactions.kpi.refundsDescription")}
        />
        <StatCard
          label={t("transactions.kpi.chargebacks")}
          value={<span className="text-rv-danger">12</span>}
          description={t("transactions.kpi.chargebacksDescription")}
        />
      </div>

      <RevenueFlow
        totals={
          breakdownTotal !== null
            ? {
                gross: grossLabel,
                refunds:
                  refundsUsd !== null
                    ? `${refundsUsd.toLocaleString()}`
                    : undefined,
                net: grossLabel,
              }
            : undefined
        }
        volume={realVolume}
        storeRows={realBreakdown}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} />
        <div className="ml-auto flex gap-1.5">
          <Button variant="light" size="sm">
            <Calendar size={13} />
            {t("transactions.actions.lastRange")}
          </Button>
          <Button variant="light" size="sm">
            <ArrowUpDown size={13} />
            {t("transactions.actions.sortNewest")}
          </Button>
        </div>
      </div>

      <TxFilterBar
        search={search}
        onSearchChange={setSearch}
        visible={filtered.length}
        total={totalEvents}
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <TransactionsTable
          transactions={filtered}
          selectedIds={selectedIds}
          activeId={selected?.id ?? null}
          total={totalEvents}
          onToggleSelect={toggleOne}
          onToggleSelectAll={toggleAll}
          onOpen={setSelectedId}
        />
        {selected ? <TransactionInspector tx={selected} /> : null}
      </div>

      {list.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="flat"
            size="sm"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage
              ? t("common.loading")
              : t("common.loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
