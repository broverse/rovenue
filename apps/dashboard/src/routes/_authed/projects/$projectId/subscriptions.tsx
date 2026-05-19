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
  type BillingIssue,
  type CalendarDay,
  type CompositionSegment,
  type IssueSeverity,
  type Subscription,
  type SubscriptionScope,
  type SubscriptionStatus,
  type SubscriptionStore,
} from "../../../../components/subscriptions";
import {
  useProjectBillingIssues,
  useProjectRenewalCalendar,
  useProjectSubscriptions,
  useProjectSubscriptionsComposition,
  useProjectSubscriptionsKpis,
} from "../../../../lib/hooks/useProjectSubscriptions";
import type {
  BillingIssueRow,
  RenewalCalendarResponse,
  SubscriptionRow,
  SubscriptionUiStatus,
  SubscriptionsCompositionResponse,
} from "@rovenue/shared";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscriptions",
)({
  component: SubscriptionsRouteComponent,
});

const TOTAL_FALLBACK = 21117;

function SubscriptionsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscriptions",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SubscriptionsPage projectId={projectId} />;
}

// =============================================================
// Wire → UI adapters
// =============================================================

const UI_STATUS_MAP: Record<SubscriptionUiStatus, SubscriptionStatus> = {
  active: "active",
  trial: "trial",
  grace: "grace",
  canceling: "canceling",
  churned: "churned",
};

const STORE_MAP: Record<string, SubscriptionStore> = {
  APP_STORE: "ios",
  APPLE: "ios",
  IOS: "ios",
  PLAY_STORE: "play",
  GOOGLE: "play",
  PLAY: "play",
  STRIPE: "stripe",
  WEB: "web",
};

function mapStore(raw: string): SubscriptionStore {
  return STORE_MAP[raw.toUpperCase()] ?? "web";
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.round((t - nowMs) / DAY_MS);
}

function termDescriptor(row: SubscriptionRow, t: ReturnType<typeof useTranslation>["t"]): string {
  if (row.isTrial) return t("subscriptions.term.trial", { defaultValue: "Trial" });
  if (row.cancellationDate) {
    const ends = new Date(row.cancellationDate);
    return t("subscriptions.term.ends", {
      defaultValue: `Ends ${ends.toLocaleDateString()}`,
      date: ends.toLocaleDateString(),
    });
  }
  return t("subscriptions.term.recurring", { defaultValue: "Recurring" });
}

// One bucket per status to seed deterministic colors that match
// the dashboard's design tokens. The CompositionSegment shape
// the page expects carries inline color tokens.
const COMPOSITION_COLOR: Record<SubscriptionUiStatus, string> = {
  active: "var(--color-rv-accent-500)",
  trial: "var(--color-rv-success)",
  canceling: "var(--color-rv-warning)",
  grace: "var(--color-rv-danger)",
  churned: "var(--color-rv-mute-600)",
};

function toUiSubscription(row: SubscriptionRow, nowMs: number, t: ReturnType<typeof useTranslation>["t"]): Subscription {
  const price = row.priceAmount !== null ? Number(row.priceAmount) : 0;
  const renewsIn = daysUntil(row.expiresDate ?? row.gracePeriodExpires, nowMs);
  return {
    id: row.id,
    user: shortId(row.subscriberId),
    product: row.productName ?? row.productIdentifier ?? row.productId,
    status: UI_STATUS_MAP[row.status],
    store: mapStore(row.store),
    price: Number.isFinite(price) ? price : 0,
    billingCycle: "monthly",
    started: row.purchaseDate.slice(0, 10),
    renewsIn,
    renewsPct: Math.max(0, Math.min(100, ((renewsIn + 30) / 60) * 100)),
    autoRenew: row.autoRenew ?? false,
    term: termDescriptor(row, t),
    trialDays: row.isTrial ? 7 : 0,
    intro: row.isIntroOffer,
    cancelPolicy:
      row.status === "canceling"
        ? "user_canceled"
        : row.status === "grace"
          ? "billing_retry"
          : "none",
    entitlements: [],
    lastIssue: row.hasIssue ? "Renewal pending" : undefined,
  };
}

function toCompositionSegments(
  response: SubscriptionsCompositionResponse | undefined,
): ReadonlyArray<CompositionSegment> | undefined {
  if (!response || response.total === 0) return undefined;
  return response.segments
    .filter((s) => s.count > 0)
    .map((s) => {
      const key: CompositionSegment["key"] =
        s.key === "churned" ? "active" : s.key;
      return {
        key,
        count: s.count,
        share: `${s.share.toFixed(1)}%`,
        color: COMPOSITION_COLOR[s.key],
      };
    });
}

function toCalendarDays(
  response: RenewalCalendarResponse | undefined,
): ReadonlyArray<CalendarDay> | undefined {
  if (!response || response.days.length === 0) return undefined;
  return response.days.map((d) => ({
    day: d.offset,
    today: d.today,
    past: d.past,
    renewals: d.renewals,
    trials: d.trials,
    grace: d.grace,
    failed: d.failed,
  }));
}

const SEVERITY_FALLBACK: IssueSeverity = "high";

function toBillingIssues(
  rows: ReadonlyArray<BillingIssueRow>,
): ReadonlyArray<BillingIssue> {
  return rows.map((r) => {
    const mrr = r.priceAmount !== null ? Number(r.priceAmount) : 0;
    return {
      user: shortId(r.subscriberId),
      id: r.purchaseId,
      issue: r.issue,
      product: r.productName ?? r.productId,
      attempts: 1,
      next: new Date(r.signalAt).toLocaleDateString(),
      severity: (r.severity as IssueSeverity) ?? SEVERITY_FALLBACK,
      mrr: Number.isFinite(mrr) ? mrr : 0,
    };
  });
}

// =============================================================
// Page
// =============================================================

function SubscriptionsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<SubscriptionScope>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [filters, setFilters] = useState({
    store: true,
    product: false,
    autoRenew: false,
  });

  const list = useProjectSubscriptions({
    projectId,
    scope: scope as Parameters<typeof useProjectSubscriptions>[0]["scope"],
    search: search.trim() || undefined,
  });
  const kpis = useProjectSubscriptionsKpis(projectId);
  const composition = useProjectSubscriptionsComposition(projectId);
  const calendar = useProjectRenewalCalendar({ projectId });
  const issues = useProjectBillingIssues(projectId, 10);

  const nowMs = useMemo(
    () => Date.now(),
    [list.dataUpdatedAt],
  );

  const realRows = useMemo<ReadonlyArray<Subscription> | null>(() => {
    const pages = list.data?.pages;
    if (!pages || pages.length === 0) return null;
    const flat = pages.flatMap((p) =>
      p.rows.map((row) => toUiSubscription(row, nowMs, t)),
    );
    return flat;
  }, [list.data, nowMs, t]);

  const filtered = useMemo<ReadonlyArray<Subscription>>(() => {
    let arr: ReadonlyArray<Subscription> = realRows ?? SUBSCRIPTIONS;
    // When falling back to mock, keep the prototype's behavior.
    if (!realRows) {
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
    }
    return arr;
  }, [realRows, scope, search]);

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (filtered.length === 0) return;
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

  const kpiTotalActive = kpis.data?.totalActive ?? 20721;
  const kpiRenewing = kpis.data?.renewing7 ?? 2184;
  const kpiGrace = kpis.data?.graceRetry ?? 84;
  const kpiCanceling = kpis.data?.canceling ?? 312;

  const compositionSegments = toCompositionSegments(composition.data);
  const compositionTotal = composition.data?.total;
  const calendarDays = toCalendarDays(calendar.data);
  const issueRows = issues.data ? toBillingIssues(issues.data.rows) : undefined;

  const totalForFilterBar =
    composition.data?.total ?? realRows?.length ?? TOTAL_FALLBACK;

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
          value={kpiTotalActive.toLocaleString()}
          description={t("subscriptions.kpi.totalActiveDelta")}
          descriptionTone="success"
        />
        <StatCard
          label={t("subscriptions.kpi.renewing7")}
          value={kpiRenewing.toLocaleString()}
          description={t("subscriptions.kpi.renewing7Description")}
        />
        <StatCard
          label={t("subscriptions.kpi.graceRetry")}
          value={
            <span className="text-rv-warning">{kpiGrace.toLocaleString()}</span>
          }
          description={t("subscriptions.kpi.graceRetryDescription")}
        />
        <StatCard
          label={t("subscriptions.kpi.canceling")}
          value={kpiCanceling.toLocaleString()}
          description={t("subscriptions.kpi.cancelingDescription")}
          descriptionTone="danger"
        />
      </div>

      <div className="mb-4">
        <CompositionBar
          updatedLabel={t("subscriptions.live.updated", { value: "12s" })}
          segments={compositionSegments}
          total={compositionTotal}
        />
      </div>

      <div className="mb-4">
        <RenewalCalendar days={calendarDays} />
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
          {totalForFilterBar.toLocaleString()}
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <BillingIssuesPanel issues={issueRows} />
        <CohortRetentionPanel />
      </div>
    </>
  );
}
