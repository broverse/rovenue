import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type {
  SubscriberListPlatform,
  SubscriberListSortMode,
  SubscriberListStatusFilter,
} from "@rovenue/shared";
import { Button } from "../../../../../ui/button";
import { StatCard } from "../../../../../ui/stat-card";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useSubscribers } from "../../../../../lib/hooks/useSubscribers";
import { useSubscriber } from "../../../../../lib/hooks/useSubscriber";
import { Search, X } from "lucide-react";
import {
  DateRangePopover,
  FilterPill,
  ScopeTabs,
  SortPopover,
  SubscriberDetailPanel,
  SubscriberFilterPopover,
  SubscribersTable,
  mapApiSubscriber,
  type Subscriber,
  type SubscriberScope,
} from "../../../../../components/subscribers";

// --- URL search-param parsing -------------------------------------------------

const SCOPE_VALUES: ReadonlyArray<SubscriberScope> = [
  "all",
  "active",
  "trial",
  "grace",
  "churn",
  "vip",
  "risk",
];

const PLATFORM_VALUES: ReadonlyArray<SubscriberListPlatform> = [
  "ios",
  "android",
  "web",
];

interface SubscribersSearch {
  scope: SubscriberScope;
  q?: string;
  entitlement?: string;
  platforms?: SubscriberListPlatform[];
  country?: string;
  ltvMin?: number;
  /** Inclusive `lastSeenAt` lower bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive `lastSeenAt` upper bound, `YYYY-MM-DD`. */
  to?: string;
  /** Sort key — defaults to `last_activity`. */
  sort: SubscriberListSortMode;
}

const SORT_VALUES: ReadonlyArray<SubscriberListSortMode> = [
  "last_activity",
  "created",
  "ltv",
  "purchases",
];

function parseSort(raw: unknown): SubscriberListSortMode {
  return typeof raw === "string" &&
    (SORT_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriberListSortMode)
    : "last_activity";
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBound(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !DATE_ONLY_RE.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : raw;
}

function parseScope(raw: unknown): SubscriberScope {
  return typeof raw === "string" && (SCOPE_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriberScope)
    : "all";
}

function parsePlatforms(raw: unknown): SubscriberListPlatform[] | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is SubscriberListPlatform =>
      (PLATFORM_VALUES as ReadonlyArray<string>).includes(p),
    );
  return parts.length > 0 ? parts : undefined;
}

function parseLtvMin(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/** Map a `SubscriberScope` to the backend `status` filter. VIP / risk
 *  don't have backend support yet — they stay client-side. */
function scopeToStatus(
  scope: SubscriberScope,
): SubscriberListStatusFilter | undefined {
  switch (scope) {
    case "active":
      return "active";
    case "trial":
      return "trial";
    case "grace":
      return "grace";
    case "churn":
      return "churned";
    default:
      return undefined;
  }
}

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscribers/",
)({
  // Persist filter state in the URL so it survives refreshes and is
  // shareable. Unknown values fall back to safe defaults so a typo'd
  // link still renders the page.
  validateSearch: (search: Record<string, unknown>): SubscribersSearch => {
    const from = parseDateBound(search.from);
    const to = parseDateBound(search.to);
    return {
      scope: parseScope(search.scope),
      q:
        typeof search.q === "string" && search.q.length > 0 ? search.q : undefined,
      entitlement:
        typeof search.entitlement === "string" && search.entitlement.length > 0
          ? search.entitlement
          : undefined,
      platforms: parsePlatforms(search.platforms),
      country:
        typeof search.country === "string" && search.country.length === 2
          ? search.country.toUpperCase()
          : undefined,
      ltvMin: parseLtvMin(search.ltvMin),
      // Drop inverted ranges so the page doesn't render an empty
      // list because of a typo in a shared link.
      from: from && to && from > to ? undefined : from,
      to: from && to && from > to ? undefined : to,
      sort: parseSort(search.sort),
    };
  },
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const {
    scope,
    q: urlSearch,
    entitlement,
    platforms,
    country,
    ltvMin,
    from,
    to,
    sort,
  } = search;

  // Local input mirror so typing stays responsive; pushed to URL
  // after a 300ms debounce.
  const [searchInput, setSearchInput] = useState(urlSearch ?? "");
  useEffect(() => {
    setSearchInput(urlSearch ?? "");
  }, [urlSearch]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim();
      if ((next || undefined) === urlSearch) return;
      void navigate({
        search: (prev) => ({ ...prev, q: next.length > 0 ? next : undefined }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, urlSearch, navigate]);

  const setScope = (next: SubscriberScope) =>
    void navigate({
      search: (prev) => ({ ...prev, scope: next }),
      replace: false,
    });

  const setFilters = (next: {
    status?: SubscriberListStatusFilter;
    entitlement?: string;
    platforms?: ReadonlyArray<SubscriberListPlatform>;
    country?: string;
    ltvMin?: number;
  }) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        // Status comes from scope tabs, not the popover — popover sets
        // it for parity but we route it through scope so the tabs stay
        // in sync.
        scope: next.status
          ? (next.status === "churned" ? "churn" : next.status)
          : prev.scope === "vip" || prev.scope === "risk"
            ? prev.scope
            : "all",
        entitlement: next.entitlement,
        platforms: next.platforms ? [...next.platforms] : undefined,
        country: next.country,
        ltvMin: next.ltvMin,
      }),
      replace: false,
    });

  const clearOne = (key: keyof SubscribersSearch) =>
    void navigate({
      search: (prev) => ({ ...prev, [key]: undefined }),
      replace: false,
    });

  const backendStatus = scopeToStatus(scope);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useSubscribers({
      projectId,
      q: urlSearch,
      status: backendStatus,
      entitlement,
      platforms,
      country,
      ltvMin,
      from,
      to,
      sort,
      limit: 50,
    });

  // Flatten + map. VIP / risk scope is still client-only over the
  // loaded pages — backend doesn't store either signal today.
  const flat = useMemo<ReadonlyArray<Subscriber>>(() => {
    if (!data) return [];
    return data.pages.flatMap((page) =>
      page.subscribers.map(mapApiSubscriber),
    );
  }, [data]);

  const filtered = useMemo<ReadonlyArray<Subscriber>>(() => {
    if (scope === "vip") return flat.filter((s) => s.vip);
    if (scope === "risk") return flat.filter((s) => s.risk >= 70);
    return flat;
  }, [flat, scope]);

  // Detail panel: fetch real subscriber when one is selected.
  const { data: detailData } = useSubscriber(projectId, activeId ?? "");

  const selectedSubscriber = useMemo<Subscriber | null>(() => {
    if (detailData) {
      const status = detailData.access.some((a) => a.isActive)
        ? "active"
        : "churned";
      return {
        id:
          detailData.appUserId.length > 20
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
        product: detailData.purchases[0]?.productIdentifier ?? "—",
        status,
        ltv: 0,
        mrr: 0,
        created: detailData.firstSeenAt,
        renew: detailData.purchases[0]?.expiresDate ?? "—",
        platforms: [],
        risk: 0,
        plan:
          detailData.access.filter((a) => a.isActive).map((a) => a.entitlementKey)[0] ??
          "—",
      };
    }
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

  const searchAreaRef = useRef<HTMLDivElement>(null);
  const focusSearchInput = () => {
    const input =
      searchAreaRef.current?.querySelector<HTMLInputElement>("input[type='text']");
    if (input) {
      input.focus();
      input.select();
    }
  };

  // Press `/` to focus the search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
        return;
      e.preventDefault();
      focusSearchInput();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const totalLoaded = flat.length;
  const activePopoverCount =
    (backendStatus ? 1 : 0) +
    (entitlement ? 1 : 0) +
    (platforms && platforms.length > 0 ? 1 : 0) +
    (country ? 1 : 0) +
    (typeof ltvMin === "number" ? 1 : 0);

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
          <Button variant="flat" size="sm" onClick={focusSearchInput}>
            <Search size={13} />
            {t("subscribers.actions.findById")}
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
        <StatCard label={t("subscribers.kpi.active")} value="—" />
        <StatCard label={t("subscribers.kpi.trial")} value="—" />
        <StatCard label={t("subscribers.kpi.risk")} value="—" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={scope} onChange={setScope} />
        <div className="ml-auto flex gap-1.5">
          <DateRangePopover
            value={{ from: from ?? null, to: to ?? null }}
            onChange={(next) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  from: next.from ?? undefined,
                  to: next.to ?? undefined,
                }),
                replace: false,
              })
            }
          />
          <SortPopover
            value={sort}
            onChange={(next) =>
              void navigate({
                search: (prev) => ({ ...prev, sort: next }),
                replace: false,
              })
            }
          />
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
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("subscribers.filters.search")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>

        {entitlement && (
          <FilterPill active onClick={() => clearOne("entitlement")}>
            {t("subscribers.filterKeys.entitlement")}
            <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">
              {entitlement}
            </span>
            <X size={10} className="opacity-50" />
          </FilterPill>
        )}
        {platforms && platforms.length > 0 && (
          <FilterPill active onClick={() => clearOne("platforms")}>
            {t("subscribers.filterKeys.platform")}
            <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">
              {platforms.join(" + ")}
            </span>
            <X size={10} className="opacity-50" />
          </FilterPill>
        )}
        {country && (
          <FilterPill active onClick={() => clearOne("country")}>
            {t("subscribers.filterKeys.country")}
            <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">
              {country}
            </span>
            <X size={10} className="opacity-50" />
          </FilterPill>
        )}
        {typeof ltvMin === "number" && (
          <FilterPill active onClick={() => clearOne("ltvMin")}>
            {t("subscribers.filterKeys.ltv")}
            <span className="font-rv-mono text-[11px] font-medium text-rv-mute-800">
              ≥ ${ltvMin}
            </span>
            <X size={10} className="opacity-50" />
          </FilterPill>
        )}

        <SubscriberFilterPopover
          value={{
            status: backendStatus,
            entitlement,
            platforms,
            country,
            ltvMin,
          }}
          onChange={setFilters}
          activeCount={activePopoverCount}
        />

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
          <SubscriberDetailPanel subscriber={selectedSubscriber} timeline={[]} />
        )}
      </div>
    </>
  );
}
