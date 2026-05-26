import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CalendarDays, Download, Plus } from "lucide-react";
import type {
  SubscriptionRow,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionUiStatus,
  SubscriptionsCompositionResponse,
} from "@rovenue/shared";
import { subscriptionSortKeys, subscriptionStoreCodes } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  CompositionBar,
  FilterToolbar,
  GrantSubscriptionModal,
  SCOPE_COUNTS,
  SUBSCRIPTIONS,
  ScheduleCancelModal,
  ScopeTabs,
  SubscriptionsTable,
  type CompositionSegment,
  type ProductOption,
  type Subscription,
  type SubscriptionScope,
  type SubscriptionStatus,
  type SubscriptionStore,
  type SubscriptionsFilterValue,
} from "../../../../components/subscriptions";
import {
  buildExportSubscriptionsUrl,
  useProjectSubscriptions,
  useProjectSubscriptionsComposition,
  useProjectSubscriptionsKpis,
} from "../../../../lib/hooks/useProjectSubscriptions";
import { useProjectProducts } from "../../../../lib/hooks/useProjectProducts";

// =============================================================
// URL search-param schema
// =============================================================

const SCOPE_VALUES: ReadonlyArray<SubscriptionScopeName> = [
  "all",
  "active",
  "trial",
  "grace",
  "canceling",
  "issues",
  "churned",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SubsSearch {
  scope: SubscriptionScopeName;
  q?: string;
  store?: SubscriptionStoreCode[];
  productId?: string[];
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
  sort: SubscriptionSortKey;
}

function parseScope(raw: unknown): SubscriptionScopeName {
  return typeof raw === "string" &&
    (SCOPE_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriptionScopeName)
    : "all";
}

function parseSort(raw: unknown): SubscriptionSortKey {
  return typeof raw === "string" &&
    (subscriptionSortKeys as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriptionSortKey)
    : "started_desc";
}

function parseStores(raw: unknown): SubscriptionStoreCode[] | undefined {
  const cands = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const allowed = new Set(subscriptionStoreCodes as ReadonlyArray<string>);
  const out = cands
    .map((s) => String(s).trim().toUpperCase())
    .filter((s): s is SubscriptionStoreCode => allowed.has(s));
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function parseIds(raw: unknown): string[] | undefined {
  const cands = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const out = cands.map((s) => String(s).trim()).filter((s) => s.length > 0);
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function parseBool(raw: unknown): boolean | undefined {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return undefined;
}

function parseDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) return undefined;
  return Number.isNaN(new Date(raw).getTime()) ? undefined : raw;
}

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscriptions",
)({
  validateSearch: (raw: Record<string, unknown>): SubsSearch => ({
    scope: parseScope(raw.scope),
    q: typeof raw.q === "string" && raw.q.length > 0 ? raw.q : undefined,
    store: parseStores(raw.store),
    productId: parseIds(raw.productId),
    autoRenew: parseBool(raw.autoRenew),
    isTrial: parseBool(raw.isTrial),
    isIntro: parseBool(raw.isIntro),
    hasIssue:
      raw.hasIssue === true || raw.hasIssue === "true" ? true : undefined,
    purchasedFrom: parseDate(raw.purchasedFrom),
    purchasedTo: parseDate(raw.purchasedTo),
    expiresFrom: parseDate(raw.expiresFrom),
    expiresTo: parseDate(raw.expiresTo),
    sort: parseSort(raw.sort),
  }),
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
// Wire → UI adapters (unchanged)
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
  MANUAL: "web",
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

function termDescriptor(
  row: SubscriptionRow,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (row.isTrial)
    return t("subscriptions.term.trial", { defaultValue: "Trial" });
  if (row.cancellationDate) {
    const ends = new Date(row.cancellationDate);
    return t("subscriptions.term.ends", {
      defaultValue: `Ends ${ends.toLocaleDateString()}`,
      date: ends.toLocaleDateString(),
    });
  }
  return t("subscriptions.term.recurring", { defaultValue: "Recurring" });
}

const COMPOSITION_COLOR: Record<SubscriptionUiStatus, string> = {
  active: "var(--color-rv-accent-500)",
  trial: "var(--color-rv-success)",
  canceling: "var(--color-rv-warning)",
  grace: "var(--color-rv-danger)",
  churned: "var(--color-rv-mute-600)",
};

function toUiSubscription(
  row: SubscriptionRow,
  nowMs: number,
  t: ReturnType<typeof useTranslation>["t"],
): Subscription {
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

// =============================================================
// Page
// =============================================================

function SubscriptionsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [grantOpen, setGrantOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Debounced search input → URL
  const [searchInput, setSearchInput] = useState(search.q ?? "");
  useEffect(() => setSearchInput(search.q ?? ""), [search.q]);
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      void navigate({
        search: (prev) => ({
          ...prev,
          q: trimmed.length > 0 ? trimmed : undefined,
        }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, navigate]);

  // Hook params derived from URL search params (skip the local searchInput).
  const list = useProjectSubscriptions({
    projectId,
    scope: search.scope,
    sort: search.sort,
    search: search.q,
    store: search.store as ReadonlyArray<SubscriptionStoreCode> | undefined,
    productId: search.productId,
    autoRenew: search.autoRenew,
    isTrial: search.isTrial,
    isIntro: search.isIntro,
    hasIssue: search.hasIssue,
    purchasedFrom: search.purchasedFrom,
    purchasedTo: search.purchasedTo,
    expiresFrom: search.expiresFrom,
    expiresTo: search.expiresTo,
  });
  const kpis = useProjectSubscriptionsKpis(projectId);
  const composition = useProjectSubscriptionsComposition(projectId);
  // First page only — product picker doesn't need to walk the cursor.
  const productList = useProjectProducts({
    projectId,
    includeInactive: false,
    limit: 100,
  });

  const nowMs = useMemo(() => Date.now(), [list.dataUpdatedAt]);

  const realRows = useMemo<ReadonlyArray<Subscription> | null>(() => {
    const pages = list.data?.pages;
    if (!pages || pages.length === 0) return null;
    return pages.flatMap((p) =>
      p.rows.map((row) => toUiSubscription(row, nowMs, t)),
    );
  }, [list.data, nowMs, t]);

  const rows: ReadonlyArray<Subscription> = realRows ?? SUBSCRIPTIONS;

  const productOptions: ReadonlyArray<ProductOption> = useMemo(() => {
    const first = productList.data?.pages?.[0];
    if (!first) return [];
    return first.products.map((p) => ({ id: p.id, label: p.displayName }));
  }, [productList.data]);

  const filterValue: SubscriptionsFilterValue = useMemo(
    () => ({
      search: searchInput,
      store: (search.store ?? []) as ReadonlyArray<SubscriptionStoreCode>,
      productId: search.productId ?? [],
      autoRenew: search.autoRenew,
      isTrial: search.isTrial,
      isIntro: search.isIntro,
      hasIssue: search.hasIssue === true,
      purchasedFrom: search.purchasedFrom,
      purchasedTo: search.purchasedTo,
      expiresFrom: search.expiresFrom,
      expiresTo: search.expiresTo,
    }),
    [search, searchInput],
  );

  const onFilterChange = (next: SubscriptionsFilterValue) => {
    setSearchInput(next.search);
    void navigate({
      search: (prev) => ({
        ...prev,
        // search is debounced via the useEffect above; don't write it here.
        store: next.store.length > 0 ? [...next.store] : undefined,
        productId:
          next.productId.length > 0 ? [...next.productId] : undefined,
        autoRenew: next.autoRenew,
        isTrial: next.isTrial,
        isIntro: next.isIntro,
        hasIssue: next.hasIssue ? true : undefined,
        purchasedFrom: next.purchasedFrom,
        purchasedTo: next.purchasedTo,
        expiresFrom: next.expiresFrom,
        expiresTo: next.expiresTo,
      }),
      replace: true,
    });
  };

  const onScopeChange = (scope: SubscriptionScope) =>
    void navigate({
      search: (prev) => ({ ...prev, scope: scope as SubscriptionScopeName }),
      replace: false,
    });

  const onSortChange = (sort: SubscriptionSortKey) =>
    void navigate({ search: (prev) => ({ ...prev, sort }), replace: false });

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (rows.length === 0) return;
    if (rows.every((s) => selectedIds.has(s.id))) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((s) => s.id)));
  };

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  // Press `/` to focus the search input
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      const input = searchInputRef.current;
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
  const totalForFilterBar =
    composition.data?.total ?? realRows?.length ?? TOTAL_FALLBACK;

  const selectedSubs = useMemo(
    () => rows.filter((s) => selectedIds.has(s.id)),
    [rows, selectedIds],
  );
  const canSchedule = selectedSubs.length > 0;
  const onExport = () =>
    window.location.assign(
      buildExportSubscriptionsUrl(projectId, search.scope, search.q ?? ""),
    );

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
          <Button
            variant="flat"
            size="sm"
            disabled={!canSchedule}
            title={
              !canSchedule
                ? t("subscriptions.actions.scheduleDisabledTooltip", {
                    defaultValue: "Select at least one row",
                  })
                : undefined
            }
            onClick={() => setScheduleOpen(true)}
          >
            <CalendarDays size={13} />
            {t("subscriptions.actions.schedule")}
          </Button>
          <Button variant="flat" size="sm" onClick={onExport}>
            <Download size={13} />
            {t("subscriptions.actions.exportCsv")}
          </Button>
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setGrantOpen(true)}
          >
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
            <span className="text-rv-warning">
              {kpiGrace.toLocaleString()}
            </span>
          }
          description={t("subscriptions.kpi.graceRetryDescription")}
        />
        <StatCard
          label={t("subscriptions.kpi.canceling")}
          value={<span>{kpiCanceling.toLocaleString()}</span>}
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

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs
          value={search.scope as SubscriptionScope}
          onChange={onScopeChange}
          counts={SCOPE_COUNTS}
        />
      </div>

      <FilterToolbar
        value={filterValue}
        onChange={onFilterChange}
        products={productOptions}
        visible={rows.length}
        total={totalForFilterBar}
        searchInputRef={searchInputRef}
      />

      <SubscriptionsTable
        subscriptions={rows}
        selectedIds={selectedIds}
        expandedId={expandedId}
        sort={search.sort}
        onSortChange={onSortChange}
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

      <GrantSubscriptionModal
        projectId={projectId}
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
      />
      <ScheduleCancelModal
        projectId={projectId}
        open={scheduleOpen}
        selected={selectedSubs}
        onClose={() => setScheduleOpen(false)}
      />
    </>
  );
}
