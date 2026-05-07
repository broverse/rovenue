import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../ui/button";
import { StatCard } from "../../../../../ui/stat-card";
import { useProject } from "../../../../../lib/hooks/useProject";
import {
  Calendar,
  ChevronsUpDown,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  FilterPill,
  ScopeTabs,
  SUBSCRIBERS,
  SubscriberDetailPanel,
  SubscribersPaginator,
  SubscribersTable,
  TIMELINE_MOCK,
  type Subscriber,
  type SubscriberScope,
} from "../../../../../components/subscribers";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscribers/",
)({
  component: SubscribersRouteComponent,
});

const TOTAL_SUBSCRIBERS = 24812;
const TOTAL_PAGES = 248;

const SCOPE_COUNTS: Record<SubscriberScope, string> = {
  all: "24.8k",
  active: "19.2k",
  trial: "1,421",
  grace: "84",
  churn: "4.1k",
  vip: "312",
  risk: "487",
};

function SubscribersRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscribers/",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SubscribersPage projectName={project.name} />;
}

function SubscribersPage({ projectName }: { projectName: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<SubscriberScope>("all");
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string>("user_7c9e22...");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [filters, setFilters] = useState({
    entitlement: true,
    platform: true,
    country: false,
    ltv: false,
  });
  const [page, setPage] = useState(1);

  const filtered = useMemo<ReadonlyArray<Subscriber>>(() => {
    let arr: ReadonlyArray<Subscriber> = SUBSCRIBERS;
    if (scope === "active") arr = arr.filter((s) => s.status === "active");
    if (scope === "trial") arr = arr.filter((s) => s.status === "trial");
    if (scope === "grace") arr = arr.filter((s) => s.status === "grace");
    if (scope === "churn")
      arr = arr.filter((s) => s.status === "churned" || s.status === "canceled");
    if (scope === "vip") arr = arr.filter((s) => s.vip);
    if (scope === "risk") arr = arr.filter((s) => s.risk >= 70);
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter(
        (s) =>
          s.full.toLowerCase().includes(q) ||
          s.alias.toLowerCase().includes(q) ||
          s.country.toLowerCase() === q,
      );
    }
    return arr;
  }, [scope, search]);

  const selected = useMemo<Subscriber>(
    () => SUBSCRIBERS.find((s) => s.id === activeId) ?? SUBSCRIBERS[0]!,
    [activeId],
  );

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

  const visibleFrom = filtered.length === 0 ? 0 : 1;
  const visibleTo = filtered.length;

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("subscribers.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("subscribers.subtitle", { project: projectName })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <Search size={13} />
            {t("subscribers.actions.findById")}
          </Button>
          <Button variant="flat" size="sm">
            <RefreshCw size={13} />
            {t("subscribers.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("subscribers.actions.grantEntitlement")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("subscribers.kpi.total")}
          value={TOTAL_SUBSCRIBERS.toLocaleString()}
          description={t("subscribers.kpi.totalDelta")}
          descriptionTone="success"
        />
        <StatCard
          label={t("subscribers.kpi.active")}
          value={(19204).toLocaleString()}
          description={
            <>
              {t("subscribers.kpi.activeBreakdown", { percent: "77.4" })}
              <span className="text-rv-success">
                {t("subscribers.kpi.activeDelta", { value: "1.8" })}
              </span>
            </>
          }
        />
        <StatCard
          label={t("subscribers.kpi.trial")}
          value={(1421).toLocaleString()}
          description={t("subscribers.kpi.trialBreakdown", { percent: "42.8" })}
        />
        <StatCard
          label={t("subscribers.kpi.risk")}
          value={
            <span className="text-rv-warning">{(487).toLocaleString()}</span>
          }
          description={t("subscribers.kpi.riskBreakdown", { amount: "$2,840" })}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} counts={SCOPE_COUNTS} />
        <div className="ml-auto flex gap-1.5">
          <Button variant="light" size="sm">
            <Calendar size={13} />
            {t("subscribers.toolbar.lastRange")}
          </Button>
          <Button variant="light" size="sm">
            <ChevronsUpDown size={13} />
            {t("subscribers.toolbar.sortByActivity")}
          </Button>
        </div>
      </div>

      <div
        ref={searchAreaRef}
        className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5"
      >
        <label className="flex h-7 min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500 sm:flex-[0_1_320px]">
          <Search size={12} className="text-rv-mute-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("subscribers.filters.search")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>
        <FilterPill active={filters.entitlement} onClick={() => toggleFilter("entitlement")}>
          {t("subscribers.filterKeys.entitlement")}
          <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">premium</span>
          <X size={10} className="opacity-50" />
        </FilterPill>
        <FilterPill active={filters.platform} onClick={() => toggleFilter("platform")}>
          {t("subscribers.filterKeys.platform")}
          <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">iOS + A</span>
          <X size={10} className="opacity-50" />
        </FilterPill>
        <FilterPill active={filters.country} onClick={() => toggleFilter("country")}>
          {t("subscribers.filterKeys.country")}
          <span className="font-rv-mono text-[11px] text-rv-mute-800">
            {t("subscribers.filters.any")}
          </span>
        </FilterPill>
        <FilterPill active={filters.ltv} onClick={() => toggleFilter("ltv")}>
          {t("subscribers.filterKeys.ltv")}
          <span className="font-rv-mono text-[11px] text-rv-mute-800">&gt; $0</span>
        </FilterPill>
        <FilterPill solid>
          <Plus size={10} />
          {t("subscribers.filters.addFilter")}
        </FilterPill>
        <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
          {filtered.length.toLocaleString()} {t("subscribers.toolbar.of")}{" "}
          {TOTAL_SUBSCRIBERS.toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <SubscribersTable
            subscribers={filtered}
            selectedIds={selectedIds}
            activeId={activeId}
            onToggleSelect={toggleOne}
            onToggleSelectAll={toggleAll}
            onOpen={setActiveId}
          />
          <SubscribersPaginator
            from={visibleFrom}
            to={visibleTo}
            total={TOTAL_SUBSCRIBERS}
            page={page}
            totalPages={TOTAL_PAGES}
            onPageChange={setPage}
          />
        </div>

        <SubscriberDetailPanel subscriber={selected} timeline={TIMELINE_MOCK} />
      </div>
    </>
  );
}
