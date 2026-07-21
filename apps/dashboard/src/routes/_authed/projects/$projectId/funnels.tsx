import { useMemo, useState } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Book,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Filter,
  Funnel as FunnelIcon,
  Globe,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../../ui/button";
import { Chip } from "../../../../ui/chip";
import { cn } from "../../../../lib/cn";
import { useProject } from "../../../../lib/hooks/useProject";
import { rpc, unwrap } from "../../../../lib/api";

export const Route = createFileRoute("/_authed/projects/$projectId/funnels")({
  component: FunnelsRoute,
});

function FunnelsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/funnels",
  });
  const { data: project } = useProject(projectId);
  // When `funnels/$funnelId` is active, defer fully to the child so
  // the Builder's full-bleed UI replaces the list rather than
  // stacking under it.
  const childMatches = useChildMatches();
  if (!project) return null;
  if (childMatches.length > 0) return <Outlet />;
  return <FunnelsPage projectId={projectId} />;
}

type FunnelStatus = "draft" | "published" | "archived";
type FunnelTone = "" | "amber" | "emerald" | "violet" | "pink" | "rose";

type Funnel = {
  id: string;
  slug: string;
  name: string;
  status: FunnelStatus;
  version: number;
  thumb: string;
  tone: FunnelTone;
  editedAt: string;
  editedBy: string;
  publishedAt: string | null;
  pages: number;
  started: number;
  completed: number;
  paid: number;
  conv: number;
  spark: number[] | null;
  pinned?: boolean;
  draftDiffers?: boolean;
  isNew?: boolean;
};


type SystemTemplate = {
  id: string;
  cat: string;
  name: string;
  desc: string;
  pages: number;
  badge?: string;
  tone: FunnelTone | "cyan";
};

const SYSTEM_TEMPLATES: ReadonlyArray<SystemTemplate> = [
  {
    id: "tpl_fitness_6q",
    cat: "FITNESS",
    name: "Fitness · 6-question intro",
    desc: "Goal → activity level → body type → frequency → email → paywall.",
    pages: 9,
    badge: "POPULAR",
    tone: "amber",
  },
  {
    id: "tpl_language",
    cat: "EDUCATION",
    name: "Language learning quiz",
    desc: "Pick a language → motivation → daily commitment → personalized plan → paywall.",
    pages: 7,
    tone: "emerald",
  },
  {
    id: "tpl_mind",
    cat: "WELLNESS",
    name: "Mindfulness onboarding",
    desc: "Stress check → sleep quality → habit goals → guided sample → paywall.",
    pages: 8,
    tone: "violet",
  },
  {
    id: "tpl_sleep",
    cat: "WELLNESS",
    name: "Sleep quiz",
    desc: "Sleep score → blockers → routine builder → paywall.",
    pages: 6,
    tone: "rose",
  },
  {
    id: "tpl_finance",
    cat: "FINANCE",
    name: "Money habits assessment",
    desc: "Income range → goals → risk → portfolio preview → paywall.",
    pages: 10,
    tone: "cyan",
  },
  {
    id: "tpl_dating",
    cat: "SOCIAL",
    name: "Dating preferences",
    desc: "Looking for → values → deal-breakers → match preview → paywall.",
    pages: 8,
    tone: "pink",
  },
];

const USER_TEMPLATES: ReadonlyArray<SystemTemplate> = [
  {
    id: "tpl_user_holiday",
    cat: "PROMO",
    name: "Posely · Holiday flow",
    desc: "Saved from Holiday promo · 2026 (v2). 5 pages including promo card.",
    pages: 6,
    tone: "pink",
  },
  {
    id: "tpl_user_quiz",
    cat: "INTERNAL",
    name: "Posely · Standard quiz shell",
    desc: "Saved Apr 9. 6 question pages → result → paywall → success.",
    pages: 9,
    tone: "amber",
  },
];

const STATUS_LABEL: Record<FunnelStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

const STATUS_DOT: Record<FunnelStatus, string> = {
  draft: "bg-rv-mute-500",
  published:
    "bg-rv-success shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-success)_20%,transparent)]",
  archived: "bg-rv-mute-400",
};

const THUMB_BG: Record<FunnelTone, string> = {
  "": "bg-gradient-to-br from-rv-accent-500 to-[color-mix(in_srgb,var(--color-rv-accent-500)_50%,var(--color-rv-violet))]",
  amber: "bg-gradient-to-br from-rv-warning to-[#fb923c]",
  emerald: "bg-gradient-to-br from-rv-success to-rv-cyan",
  violet: "bg-gradient-to-br from-rv-violet to-[#c084fc]",
  pink: "bg-gradient-to-br from-[#ec4899] to-rv-violet",
  rose: "bg-gradient-to-br from-rv-danger to-[#ec4899]",
};

const TONE_VAR: Record<SystemTemplate["tone"], string> = {
  "": "var(--color-rv-accent-500)",
  amber: "var(--color-rv-warning)",
  emerald: "var(--color-rv-success)",
  violet: "var(--color-rv-violet)",
  pink: "#ec4899",
  rose: "var(--color-rv-danger)",
  cyan: "var(--color-rv-cyan)",
};

function Sparkline({ data, color = "var(--color-rv-accent-500)" }: { data: number[] | null; color?: string }) {
  if (!data) {
    return <div className="font-rv-mono text-[11px] text-rv-mute-500">—</div>;
  }
  const w = 80;
  const h = 22;
  const max = Math.max(...data, 1);
  const pts = data.map((d, i) => [
    (i / Math.max(data.length - 1, 1)) * w,
    h - (d / max) * (h - 2) - 1,
  ]);
  const path = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .join(" ");
  const area = `${path} L ${w},${h} L 0,${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-[22px] w-20"
      aria-hidden
    >
      <path d={area} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      {last && <circle cx={last[0]} cy={last[1]} r="1.8" fill={color} />}
    </svg>
  );
}

type Scope = "all" | "published" | "draft" | "archived";

interface ApiFunnelRow {
  id: string;
  slug: string;
  name: string;
  status: FunnelStatus;
  currentVersionId: string | null;
  draftPagesJson: unknown;
  createdAt: string;
  updatedAt: string;
}

// Map an API funnel row onto the legacy list-page Funnel shape. Stats
// default to zero — the dashboard's project-aggregate analytics endpoint
// doesn't exist yet, so the table renders the placeholder until that lands.
function rowToFunnel(row: ApiFunnelRow): Funnel {
  const pageCount = Array.isArray(row.draftPagesJson) ? row.draftPagesJson.length : 0;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    version: 0,
    thumb: row.name.charAt(0).toUpperCase() || "F",
    tone: "",
    editedAt: row.updatedAt,
    editedBy: "",
    publishedAt: row.currentVersionId ? row.updatedAt : null,
    pages: pageCount,
    started: 0,
    completed: 0,
    paid: 0,
    conv: 0,
    spark: null,
  };
}

function useFunnelsList(projectId: string) {
  return useQuery({
    queryKey: ["dashboard-funnels", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ funnels: ApiFunnelRow[] }>(
        rpc.dashboard.projects[":projectId"].funnels.$get({ param: { projectId } }),
      ),
    select: (r) => r.funnels.map(rowToFunnel),
  });
}

function useCreateFunnel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string }) =>
      unwrap<ApiFunnelRow>(
        rpc.dashboard.projects[":projectId"].funnels.$post({
          param: { projectId },
          json: body,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-funnels", projectId] }),
  });
}

function FunnelsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>("all");
  const [sortBy, setSortBy] = useState("Recently edited");
  const [query, setQuery] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);

  const { data: funnels = [] } = useFunnelsList(projectId);

  const filtered = useMemo(
    () =>
      funnels.filter((f) => {
        if (scope !== "all" && f.status !== scope) return false;
        if (
          query &&
          !(`${f.name} ${f.slug}`.toLowerCase().includes(query.toLowerCase()))
        )
          return false;
        return true;
      }),
    [funnels, scope, query],
  );

  const counts = useMemo(
    () => ({
      all: funnels.length,
      published: funnels.filter((f) => f.status === "published").length,
      draft: funnels.filter((f) => f.status === "draft").length,
      archived: funnels.filter((f) => f.status === "archived").length,
    }),
    [funnels],
  );

  const totalSessions = funnels.reduce((a, f) => a + f.started, 0);
  const totalPaid = funnels.reduce((a, f) => a + f.paid, 0);
  const avgConv = totalSessions ? (totalPaid / totalSessions) * 100 : 0;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="flex items-center gap-3 text-[24px] font-semibold leading-8 tracking-tight">
            {t("funnels.title", "Funnels")}
            <Chip tone="default" className="h-[22px] gap-1 px-2 text-[11px] font-medium">
              <Globe size={11} />
              {t("funnels.platform.web", "Web")}
            </Chip>
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t(
              "funnels.subtitle",
              "Public mobile-web onboarding flows. Visitors answer questions → see a result → hit a paywall → install the native app already paid.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <Book size={13} />
            {t("funnels.actions.guide", "Funnels guide")}
          </Button>
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setShowTemplates(true)}
          >
            <Plus size={13} />
            {t("funnels.actions.new", "New funnel")}
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <div className="mb-4 grid grid-cols-1 overflow-hidden rounded-lg border border-rv-divider bg-rv-c1 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label={t("funnels.kpi.live", "PUBLISHED · LIVE")}
          value={counts.published.toString()}
          detail={
            <>
              <span className={cn("size-1.5 rounded-full", STATUS_DOT.published)} />
              {t("funnels.kpi.liveDetail", "{{draft}} in draft · {{archived}} archived", {
                draft: counts.draft,
                archived: counts.archived,
              })}
            </>
          }
        />
        <Kpi
          label={t("funnels.kpi.sessions", "SESSIONS · 7D")}
          value={totalSessions.toLocaleString()}
          detail={t("funnels.kpi.sessionsDetail", "across all funnels · ▲ 18.2% vs prev")}
        />
        <Kpi
          label={t("funnels.kpi.conv", "SESSION → PAID")}
          value={`${avgConv.toFixed(1)}%`}
          detail={t("funnels.kpi.convDetail", "weighted avg · est. {{paid}} paid", {
            paid: totalPaid.toLocaleString(),
          })}
        />
        <Kpi
          label={t("funnels.kpi.top", "TOP FUNNEL")}
          value="fitness-goal-quiz"
          valueClassName="text-[16px] leading-[22px]"
          detail="10.0% conv · 1,842 paid"
        />
      </div>

      {!hintDismissed && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-rv-accent-500/25 bg-rv-accent-500/[0.07] px-4 py-3 text-[12px]">
          <div className="flex size-7 items-center justify-center rounded-md bg-rv-accent-500/15 text-rv-accent-500">
            <Sparkles size={14} />
          </div>
          <div className="flex-1 text-rv-mute-700">
            <b className="font-medium text-foreground">{t("funnels.hint.label", "New:")}</b>{" "}
            {t(
              "funnels.hint.body",
              "sessions tab now shows live answer trails. Open ",
            )}
            <span className="rounded bg-rv-c3 px-1 py-0.5 font-rv-mono text-[11px]">fitness-goal-quiz</span>
            {" → "}
            <span className="rounded bg-rv-c3 px-1 py-0.5 font-rv-mono text-[11px]">Sessions</span>
            {" "}
            {t("funnels.hint.tail", "to see visitors mid-funnel.")}
          </div>
          <Button
            variant="light"
            size="icon"
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss"
            className="size-7"
          >
            <X size={12} />
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-t-lg border border-b-0 border-rv-divider bg-rv-c1 px-3 py-2.5">
        <div className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {(
            [
              { k: "all", l: "All", n: counts.all },
              { k: "published", l: "Published", n: counts.published },
              { k: "draft", l: "Draft", n: counts.draft },
              { k: "archived", l: "Archived", n: counts.archived },
            ] as const
          ).map((s) => (
            <button
              key={s.k}
              type="button"
              onClick={() => setScope(s.k)}
              className={cn(
                "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition",
                scope === s.k
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {s.l}
              <span className="ml-1 font-rv-mono text-[10px] text-rv-mute-500">
                {s.n}
              </span>
            </button>
          ))}
        </div>
        <label className="relative flex h-[30px] max-w-[360px] flex-1 items-center rounded-md border border-rv-divider bg-rv-c2 px-2.5 focus-within:border-rv-accent-500">
          <Search size={13} className="text-rv-mute-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("funnels.search.placeholder", "Search by name or slug…")}
            className="ml-2 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-rv-mute-500"
          />
        </label>
        <div className="flex-1" />
        <Button
          variant="flat"
          size="sm"
          className="h-[30px]"
          onClick={() =>
            setSortBy((prev) =>
              prev === "Recently edited" ? "Most sessions" : "Recently edited",
            )
          }
        >
          <Filter size={13} />
          <span>Sort:</span>
          <span className="ml-1 text-rv-mute-600">{sortBy}</span>
          <ChevronDown size={11} />
        </Button>
        <Button
          variant="flat"
          size="icon"
          className="size-[30px]"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCcw size={13} />
        </Button>
      </div>

      {/* Table or empty state */}
      <div className="overflow-hidden rounded-b-lg border border-rv-divider bg-rv-c1">
        {filtered.length === 0 ? (
          <div className="px-6 py-20 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-xl border border-rv-divider bg-rv-c2 text-rv-accent-500">
              <FunnelIcon size={26} />
            </div>
            <h3 className="mb-1.5 text-[16px] font-semibold">
              {t("funnels.empty.title", "No funnels match")}
            </h3>
            <p className="mx-auto mb-4 max-w-[440px] text-[13px] text-rv-mute-500">
              {t(
                "funnels.empty.body",
                "Try a different status filter, or clear your search.",
              )}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th className="w-[28%]">Funnel</Th>
                  <Th>Status</Th>
                  <Th>Pages</Th>
                  <Th>Edited</Th>
                  <Th align="right">Sessions · 7d</Th>
                  <Th align="right">Completed</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right">Conv.</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <FunnelRow key={f.id} funnel={f} projectId={projectId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between border-t border-rv-divider pt-4 text-[12px] text-rv-mute-500">
        <div className="font-rv-mono">
          {filtered.length} of {funnels.length} funnels
        </div>
        <div className="font-rv-mono">⌘N to create · F to focus search</div>
      </div>

      {showTemplates && (
        <TemplatesModal
          projectId={projectId}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </>
  );
}

function Kpi({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  detail: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="border-r border-rv-divider px-[18px] py-4 last:border-r-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-rv-mono text-[22px] font-medium leading-none tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-500">
        {detail}
      </div>
    </div>
  );
}

function Th({
  children,
  align,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] border-b border-rv-divider bg-rv-c2 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

function FunnelRow({
  funnel: f,
  projectId,
}: {
  funnel: Funnel;
  projectId: string;
}) {
  return (
    <tr className="group border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]">
      <td className="px-3.5 py-3.5 align-middle">
        <Link
          to="/projects/$projectId/funnels/$funnelId"
          params={{ projectId, funnelId: f.id }}
          className="flex cursor-pointer items-center gap-3 text-inherit no-underline"
        >
          <div
            className={cn(
              "relative flex size-9 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]",
              THUMB_BG[f.tone],
            )}
          >
            {f.thumb}
            <div
              title="Web funnel"
              className="absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-[4px] border border-rv-c4 bg-rv-c2 text-rv-mute-600"
            >
              <Globe size={9} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              {f.name}
              {f.isNew && (
                <span className="inline-flex h-4 items-center rounded-full bg-rv-accent-500/15 px-1.5 font-rv-mono text-[9px] font-medium text-rv-accent-500">
                  NEW
                </span>
              )}
            </div>
            <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
              /{f.slug}
            </div>
          </div>
        </Link>
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <div className="inline-flex items-center gap-1.5 text-[11px]">
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[f.status])} />
          <span className="text-rv-mute-700">{STATUS_LABEL[f.status]}</span>
          {f.status === "published" && (
            <span className="font-rv-mono text-[11px] text-rv-mute-600">
              · v{f.version}
            </span>
          )}
          {f.draftDiffers && (
            <span className="ml-1 inline-flex h-4 items-center rounded-full bg-rv-warning/15 px-1.5 font-rv-mono text-[9px] font-medium text-rv-warning">
              UNPUBLISHED CHANGES
            </span>
          )}
        </div>
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <span className="font-rv-mono text-[12px] text-rv-mute-600">
          {f.pages}
        </span>
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <div className="text-[12px] text-rv-mute-700">{f.editedAt}</div>
        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          @{f.editedBy}
        </div>
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <div className="flex items-center justify-end gap-2.5 font-rv-mono tabular-nums">
          <Sparkline data={f.spark} />
          <span className="min-w-[50px] text-right">
            {f.started.toLocaleString()}
          </span>
        </div>
      </td>
      <td className="px-3.5 py-3.5 text-right align-middle font-rv-mono tabular-nums">
        {f.completed.toLocaleString()}
      </td>
      <td
        className={cn(
          "px-3.5 py-3.5 text-right align-middle font-rv-mono tabular-nums",
          f.paid > 0 ? "text-rv-success" : "text-rv-mute-500",
        )}
      >
        {f.paid.toLocaleString()}
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <div className="flex items-center justify-end gap-2 font-rv-mono tabular-nums">
          <div className="h-1 w-16 overflow-hidden rounded-full bg-rv-c4">
            <span
              className="block h-full rounded-full bg-rv-accent-500"
              style={{ width: `${Math.min(100, f.conv * 8)}%` }}
            />
          </div>
          <span className="min-w-[42px] text-right">{f.conv.toFixed(1)}%</span>
        </div>
      </td>
      <td className="px-3.5 py-3.5 align-middle">
        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <RowAction title="Open builder">
            <Pencil size={13} />
          </RowAction>
          <RowAction title="Duplicate">
            <Copy size={13} />
          </RowAction>
          <RowAction title="Share">
            <Share2 size={13} />
          </RowAction>
          <RowAction title="More">
            <MoreHorizontal size={13} />
          </RowAction>
        </div>
      </td>
    </tr>
  );
}

function RowAction({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      className="flex size-7 cursor-pointer items-center justify-center rounded border border-transparent text-rv-mute-500 transition hover:border-rv-divider hover:bg-rv-c3 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function TemplatesModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<SystemTemplate | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const navigate = useNavigate();
  const createFunnel = useCreateFunnel(projectId);

  const toSlug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const select = (tpl: SystemTemplate) => {
    setPicked(tpl);
    setName(tpl.name);
    setSlug(toSlug(tpl.name));
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[200] flex animate-rv-fade-in items-center justify-center bg-black/60 p-6 backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-[1100px] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
      >
        {!picked ? (
          <>
            <ModalHead onClose={onClose}>
              <h2 className="m-0 text-[18px] font-semibold tracking-tight">
                New funnel
              </h2>
              <p className="mt-1 text-[13px] text-rv-mute-500">
                Pick a starting point. You can fully customize pages, theme, and rules after.
              </p>
            </ModalHead>
            <div className="overflow-y-auto p-6">
              <button
                type="button"
                onClick={() =>
                  select({
                    id: "blank",
                    name: "Untitled funnel",
                    cat: "BLANK",
                    desc: "",
                    pages: 3,
                    tone: "",
                  })
                }
                className="flex w-full cursor-pointer items-center gap-3.5 rounded-lg border border-dashed border-rv-divider-strong bg-rv-c2 px-5 py-4 text-left transition hover:border-rv-accent-500 hover:bg-rv-c3"
              >
                <div className="flex size-10 items-center justify-center rounded-lg border border-rv-divider bg-rv-c3 text-rv-mute-600">
                  <FileText size={18} />
                </div>
                <div className="flex-1">
                  <h4 className="m-0 text-[13px] font-semibold">Start from scratch</h4>
                  <p className="mt-0.5 text-[11px] text-rv-mute-500">
                    Minimal valid funnel — one question page → paywall → success. Build the rest yourself.
                  </p>
                </div>
                <ChevronRight size={14} className="text-rv-mute-500" />
              </button>

              <div className="h-6" />

              <TemplateSection
                title="System templates"
                meta={`${SYSTEM_TEMPLATES.length} curated by Rovenue`}
                templates={SYSTEM_TEMPLATES}
                onPick={select}
              />
              <div className="h-7" />
              <TemplateSection
                title="Your templates"
                meta={`${USER_TEMPLATES.length} saved by this project`}
                templates={USER_TEMPLATES}
                onPick={select}
              />
            </div>
          </>
        ) : (
          <>
            <ModalHead onClose={onClose}>
              <h2 className="m-0 text-[18px] font-semibold tracking-tight">
                Name your funnel
              </h2>
              <p className="mt-1 text-[13px] text-rv-mute-500">
                Using template{" "}
                <span className="ml-1 rounded bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[12px]">
                  {picked.id}
                </span>
                . You can change everything later.
              </p>
            </ModalHead>
            <div className="overflow-y-auto p-6" style={{ maxWidth: 520 }}>
              <div className="flex flex-col gap-3">
                <Field label="Display name">
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setSlug(toSlug(e.target.value));
                    }}
                    className="h-[34px] w-full rounded-md border border-rv-divider bg-rv-c2 px-3 text-[13px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </Field>
                <Field label="Slug · used in the public URL">
                  <input
                    value={slug}
                    onChange={(e) =>
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                    }
                    className="h-[34px] w-full rounded-md border border-rv-divider bg-rv-c2 px-3 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                  <div className="mt-1 font-rv-mono text-[11px] text-rv-mute-500">
                    https://funnels.posely.app/
                    <span className="text-foreground">{slug || "your-slug"}</span>
                  </div>
                </Field>
                <div className="mt-2 flex items-center justify-between">
                  <Button variant="light" size="sm" onClick={() => setPicked(null)}>
                    <ArrowLeft size={13} />
                    Back to templates
                  </Button>
                  <Button
                    variant="solid-primary"
                    size="sm"
                    disabled={!name || !slug || createFunnel.isPending}
                    onClick={async () => {
                      // Template-based create isn't wired yet — only the
                      // blank "Start from scratch" path lands here. The
                      // server seeds an empty draft pages_json; the
                      // builder then takes over.
                      const created = await createFunnel.mutateAsync({ name, slug });
                      onClose();
                      navigate({
                        to: "/projects/$projectId/funnels/$funnelId",
                        params: { projectId, funnelId: created.id },
                      });
                    }}
                  >
                    {createFunnel.isPending ? "Creating…" : "Create funnel"}
                    <ArrowRight size={13} />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModalHead({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between border-b border-rv-divider px-6 py-4">
      <div>{children}</div>
      <Button variant="light" size="icon" aria-label="Close" onClick={onClose}>
        <X size={14} />
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function TemplateSection({
  title,
  meta,
  templates,
  onPick,
}: {
  title: string;
  meta: string;
  templates: ReadonlyArray<SystemTemplate>;
  onPick: (tpl: SystemTemplate) => void;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">{meta}</span>
      </div>
      <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => onPick(t)}
            className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c2 text-left transition hover:-translate-y-px hover:border-rv-accent-500"
          >
            <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-rv-c3 to-rv-c2">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(135deg, transparent 0 14px, rgba(255,255,255,0.015) 14px 16px)",
                }}
              />
              <div
                className="absolute left-1/2 top-1/2 flex h-[156px] w-[88px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-rv-divider-strong bg-rv-c1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                aria-hidden
              >
                <div className="h-1.5 rounded-t-[10px] bg-rv-c3" />
                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  <div className="h-1.5 w-3/5 rounded-sm bg-rv-c3" />
                  <div className="h-1.5 w-4/5 rounded-sm bg-rv-c3" />
                  <div className="h-1.5 rounded-sm bg-rv-c3" />
                  <div
                    className="mx-auto my-1 h-5 w-5 rounded-full"
                    style={{ background: TONE_VAR[t.tone] }}
                  />
                  <div
                    className="mt-auto h-3.5 rounded-full"
                    style={{ background: TONE_VAR[t.tone] }}
                  />
                </div>
              </div>
            </div>
            <div className="px-3.5 py-3">
              <div className="mb-1 flex items-center gap-1.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                {t.cat}
                {t.badge && (
                  <span className="inline-flex h-4 items-center rounded-full bg-rv-accent-500/15 px-1.5 text-[9px] font-medium text-rv-accent-500">
                    {t.badge}
                  </span>
                )}
              </div>
              <h4 className="m-0 mb-1 text-[13px] font-semibold">{t.name}</h4>
              <p className="text-[11px] leading-relaxed text-rv-mute-500">{t.desc}</p>
            </div>
            <div className="flex items-center justify-between border-t border-rv-divider px-3.5 py-2.5 font-rv-mono text-[11px] text-rv-mute-600">
              <span>{t.pages} pages</span>
              <span className="inline-flex items-center gap-1">
                Use template <ArrowRight size={11} />
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
