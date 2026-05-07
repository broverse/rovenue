import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  CalendarDays,
  ChevronsUpDown,
  Download,
  MoreHorizontal,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import { FilterPill } from "../../../../components/subscribers/filter-pill";
import {
  BillingIssuesPanel,
  CohortRetentionPanel,
  CompositionBar,
  RenewalCalendar,
  SCOPE_COUNTS,
  SUBSCRIPTIONS,
  ScopeTabs,
  SubscriptionsTable,
  type Subscription,
  type SubscriptionScope,
} from "../../../../components/subscriptions";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscriptions",
)({
  component: SubscriptionsRouteComponent,
});

const TOTAL_SUBSCRIPTIONS = 21117;

function SubscriptionsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscriptions",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SubscriptionsPage />;
}

function SubscriptionsPage() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<SubscriptionScope>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>("sub_01HX9K2");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [filters, setFilters] = useState({
    store: true,
    product: false,
    autoRenew: false,
  });

  const filtered = useMemo<ReadonlyArray<Subscription>>(() => {
    let arr: ReadonlyArray<Subscription> = SUBSCRIPTIONS;
    if (scope === "active") arr = arr.filter((s) => s.status === "active");
    if (scope === "trial") arr = arr.filter((s) => s.status === "trial");
    if (scope === "grace") arr = arr.filter((s) => s.status === "grace");
    if (scope === "canceling")
      arr = arr.filter((s) => s.status === "canceling");
    if (scope === "issues") arr = arr.filter((s) => Boolean(s.lastIssue));
    if (scope === "churned") arr = arr.filter((s) => s.status === "churned");

    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.user.toLowerCase().includes(q) ||
          s.product.toLowerCase().includes(q),
      );
    }
    return arr;
  }, [scope, search]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (filtered.every((s) => selectedIds.has(s.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((s) => s.id)));
    }
  };

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  const toggleFilter = (key: keyof typeof filters) =>
    setFilters((f) => ({ ...f, [key]: !f[key] }));

  // Press `/` to focus the search input.
  const searchAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const input =
        searchAreaRef.current?.querySelector<HTMLInputElement>("input[type='text']");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("subscriptions.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("subscriptions.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <CalendarDays size={13} />
            {t("subscriptions.actions.schedule")}
          </Button>
          <Button variant="flat" size="sm">
            <Download size={13} />
            {t("subscriptions.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("subscriptions.actions.newSubscription")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("subscriptions.kpi.totalActive")}
          value={(20721).toLocaleString()}
          description={t("subscriptions.kpi.totalActiveDelta")}
          descriptionTone="success"
        />
        <StatCard
          label={t("subscriptions.kpi.renewing7")}
          value={(2184).toLocaleString()}
          description={t("subscriptions.kpi.renewing7Description")}
        />
        <StatCard
          label={t("subscriptions.kpi.graceRetry")}
          value={
            <span className="text-rv-warning">{(84).toLocaleString()}</span>
          }
          description={t("subscriptions.kpi.graceRetryDescription")}
        />
        <StatCard
          label={t("subscriptions.kpi.canceling")}
          value={(312).toLocaleString()}
          description={t("subscriptions.kpi.cancelingDescription")}
          descriptionTone="danger"
        />
      </div>

      <div className="mb-4">
        <CompositionBar
          updatedLabel={t("subscriptions.live.updated", { value: "12s" })}
        />
      </div>

      <div className="mb-4">
        <RenewalCalendar />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} counts={SCOPE_COUNTS} />
        <div className="ml-auto flex gap-1.5">
          <Button variant="light" size="sm">
            <ChevronsUpDown size={13} />
            {t("subscriptions.toolbar.sortNextRenewal")}
          </Button>
          <Button
            variant="light"
            size="icon"
            aria-label={t("subscriptions.toolbar.more")}
          >
            <MoreHorizontal size={14} />
          </Button>
        </div>
      </div>

      <div
        ref={searchAreaRef}
        className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5"
      >
        <label className="flex h-7 min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500 sm:flex-[0_1_360px]">
          <Search size={12} className="text-rv-mute-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("subscriptions.filters.search")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>
        <FilterPill active={filters.store} onClick={() => toggleFilter("store")}>
          {t("subscriptions.filters.store")}
          <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">
            {t("subscriptions.filters.storeValue")}
          </span>
          <X size={10} className="opacity-50" />
        </FilterPill>
        <FilterPill
          active={filters.product}
          onClick={() => toggleFilter("product")}
        >
          {t("subscriptions.filters.product")}
          <span className="font-rv-mono text-[11px] text-rv-mute-800">
            {t("subscriptions.filters.any")}
          </span>
        </FilterPill>
        <FilterPill
          active={filters.autoRenew}
          onClick={() => toggleFilter("autoRenew")}
        >
          {t("subscriptions.filters.autoRenew")}
          <span className="font-rv-mono text-[11px] text-rv-mute-800">
            {t("subscriptions.filters.autoRenewValue")}
          </span>
        </FilterPill>
        <FilterPill solid>
          <Plus size={10} />
          {t("subscriptions.filters.addFilter")}
        </FilterPill>
        <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
          {filtered.length.toLocaleString()}{" "}
          {t("subscriptions.filters.of")}{" "}
          {TOTAL_SUBSCRIPTIONS.toLocaleString()}
        </span>
      </div>

      <SubscriptionsTable
        subscriptions={filtered}
        selectedIds={selectedIds}
        expandedId={expandedId}
        onToggleSelect={toggleOne}
        onToggleSelectAll={toggleAll}
        onToggleExpand={toggleExpand}
      />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <BillingIssuesPanel />
        <CohortRetentionPanel />
      </div>
    </>
  );
}
