import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../ui/button";
import { StatCard } from "../../../../../ui/stat-card";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useSubscribers } from "../../../../../lib/hooks/useSubscribers";
import { useSubscriber } from "../../../../../lib/hooks/useSubscriber";
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
  SubscriberDetailPanel,
  SubscribersTable,
  mapApiSubscriber,
  type Subscriber,
  type SubscriberScope,
} from "../../../../../components/subscribers";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscribers/",
)({
  component: SubscribersRouteComponent,
});

function SubscribersRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscribers/",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SubscribersPage projectId={projectId} projectName={project.name} />;
}

function SubscribersPage({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<SubscriberScope>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [filters, setFilters] = useState({
    entitlement: true,
    platform: true,
    country: false,
    ltv: false,
  });

  // Debounce search input by 300ms before hitting the API.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useSubscribers({
    projectId,
    q: debouncedSearch || undefined,
    limit: 50,
  });

  // Flatten all loaded pages and map to the UI Subscriber shape.
  const flat = useMemo<ReadonlyArray<Subscriber>>(() => {
    if (!data) return [];
    return data.pages.flatMap((page) =>
      page.subscribers.map(mapApiSubscriber),
    );
  }, [data]);

  // Client-side scope filter over loaded pages (acceptable degradation).
  const filtered = useMemo<ReadonlyArray<Subscriber>>(() => {
    if (scope === "all") return flat;
    if (scope === "active") return flat.filter((s) => s.status === "active");
    if (scope === "trial") return flat.filter((s) => s.status === "trial");
    if (scope === "grace") return flat.filter((s) => s.status === "grace");
    if (scope === "churn")
      return flat.filter((s) => s.status === "churned" || s.status === "canceled");
    if (scope === "vip") return flat.filter((s) => s.vip);
    if (scope === "risk") return flat.filter((s) => s.risk >= 70);
    return flat;
  }, [flat, scope]);

  // Scope counts over loaded items only.
  const scopeCounts = useMemo<Partial<Record<SubscriberScope, string>>>(() => {
    const activeCount = flat.filter((s) => s.status === "active").length;
    const trialCount = flat.filter((s) => s.status === "trial").length;
    const graceCount = flat.filter((s) => s.status === "grace").length;
    const churnCount = flat.filter(
      (s) => s.status === "churned" || s.status === "canceled",
    ).length;
    const vipCount = flat.filter((s) => s.vip).length;
    const riskCount = flat.filter((s) => s.risk >= 70).length;
    return {
      all: flat.length.toLocaleString() + (hasNextPage ? "+" : ""),
      active: activeCount.toLocaleString(),
      trial: trialCount.toLocaleString(),
      grace: graceCount.toLocaleString(),
      churn: churnCount.toLocaleString(),
      vip: vipCount.toLocaleString(),
      risk: riskCount.toLocaleString(),
    };
  }, [flat, hasNextPage]);

  // Detail panel: fetch real subscriber when one is selected.
  const { data: detailData } = useSubscriber(
    projectId,
    activeId ?? "",
  );

  // Map SubscriberDetail → Subscriber for the panel.
  const selectedSubscriber = useMemo<Subscriber | null>(() => {
    if (detailData) {
      const status = detailData.access.some((a) => a.isActive) ? "active" : "churned";
      return {
        id: detailData.appUserId.length > 20
          ? `${detailData.appUserId.slice(0, 17)}...`
          : detailData.appUserId,
        full: detailData.appUserId,
        alias:
          detailData.appUserId.length > 24
            ? `${detailData.appUserId.slice(0, 21)}...`
            : detailData.appUserId,
        country: "US",
        entitlements: detailData.access
          .filter((a) => a.isActive)
          .map((a) => a.entitlementKey),
        product:
          detailData.purchases[0]?.productIdentifier ?? "—",
        status,
        ltv: 0,
        mrr: 0,
        created: detailData.firstSeenAt,
        renew: detailData.purchases[0]?.expiresDate ?? "—",
        platforms: [],
        risk: 0,
        plan:
          detailData.access
            .filter((a) => a.isActive)
            .map((a) => a.entitlementKey)[0] ?? "—",
      };
    }
    // Fallback to flat list while detail loads.
    if (activeId) {
      return flat.find((s) => s.full === activeId) ?? null;
    }
    return null;
  }, [detailData, activeId, flat]);

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

  const totalLoaded = flat.length;

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

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("subscribers.kpi.total")}
          value={
            isLoading
              ? "—"
              : totalLoaded.toLocaleString() + (hasNextPage ? "+" : "")
          }
        />
        <StatCard
          label={t("subscribers.kpi.active")}
          value="—"
        />
        <StatCard
          label={t("subscribers.kpi.trial")}
          value="—"
        />
        <StatCard
          label={t("subscribers.kpi.risk")}
          value="—"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} counts={scopeCounts} />
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
          {filtered.length.toLocaleString()}
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

          {/* Load more / end-of-list indicator */}
          <div className="flex items-center justify-between border-t border-rv-divider px-3.5 py-2.5 text-[12px] text-rv-mute-600">
            <span className="font-rv-mono">
              {isLoading
                ? t("subscribers.paginator.loading", "Loading…")
                : `${totalLoaded.toLocaleString()}${hasNextPage ? "+" : ""} ${t("subscribers.toolbar.subscribers", "subscribers")}`}
            </span>
            {hasNextPage && (
              <Button
                variant="flat"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage
                  ? t("subscribers.paginator.loading", "Loading…")
                  : t("subscribers.paginator.loadMore", "Load more")}
              </Button>
            )}
          </div>
        </div>

        {selectedSubscriber && (
          <SubscriberDetailPanel
            subscriber={selectedSubscriber}
            timeline={[]}
          />
        )}
      </div>
    </>
  );
}
