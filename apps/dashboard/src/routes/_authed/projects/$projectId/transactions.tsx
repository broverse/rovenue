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
  type Transaction,
  type TxScope,
} from "../../../../components/transactions";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/transactions")({
  component: TransactionsRoute,
});

function TransactionsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/transactions",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <TransactionsPage />;
}

function TransactionsPage() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<TxScope>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>(TRANSACTIONS[0]!.id);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const filtered = useMemo<ReadonlyArray<Transaction>>(() => {
    let arr: ReadonlyArray<Transaction> = TRANSACTIONS;
    if (scope === "purchase") arr = arr.filter((tx) => tx.type === "purchase");
    if (scope === "renewal") arr = arr.filter((tx) => tx.type === "renewal");
    if (scope === "refund") arr = arr.filter((tx) => tx.type === "refund" || tx.type === "chargeback");
    if (scope === "trial") arr = arr.filter((tx) => tx.type === "trial");
    if (scope === "failed")
      arr = arr.filter((tx) => tx.status === "failed" || tx.status === "disputed" || tx.status === "disputing");

    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((tx) => {
        const haystack = [tx.id, tx.user, tx.sub, tx.product, tx.country, tx.method].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    }
    return arr;
  }, [scope, search]);

  const selected = useMemo<Transaction>(() => {
    return TRANSACTIONS.find((tx) => tx.id === selectedId) ?? TRANSACTIONS[0]!;
  }, [selectedId]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (filtered.every((tx) => selectedIds.has(tx.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((tx) => tx.id)));
    }
  };

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
          <Button variant="flat" size="sm">
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
          value="$248,192.40"
          description={t("transactions.kpi.grossDelta")}
          descriptionTone="success"
        />
        <StatCard
          label={t("transactions.kpi.net28d")}
          value="$186,140.30"
          description={t("transactions.kpi.netDescription")}
        />
        <StatCard
          label={t("transactions.kpi.refunds")}
          value={<span className="text-rv-danger">−$3,842.18</span>}
          description={t("transactions.kpi.refundsDescription")}
        />
        <StatCard
          label={t("transactions.kpi.chargebacks")}
          value={<span className="text-rv-danger">12</span>}
          description={t("transactions.kpi.chargebacksDescription")}
        />
      </div>

      <RevenueFlow />

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
        total={TX_TOTAL_EVENTS}
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <TransactionsTable
          transactions={filtered}
          selectedIds={selectedIds}
          activeId={selected.id}
          total={TX_TOTAL_EVENTS}
          onToggleSelect={toggleOne}
          onToggleSelectAll={toggleAll}
          onOpen={setSelectedId}
        />
        <TransactionInspector tx={selected} />
      </div>
    </>
  );
}
