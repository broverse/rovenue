import { injectable } from "impair";
import { rpc, unwrap } from "../api";

export interface FunnelSessionRowDto {
  id: string;
  startedAt: string;
  lastActivityAt: string;
  state: "in_progress" | "paid" | "completed" | "abandoned";
  currentPageId: string | null;
  utmSource: string | null;
  answersCount: number;
}

export interface FunnelSessionsStatsDto {
  started: number;
  completionRate: number;
  paywallViewRate: number;
  paidConversion: number;
  medianDurationMs: number | null;
}

export interface FunnelSessionDetailDto extends FunnelSessionRowDto {
  answers: Array<{ pageId: string; questionId: string; answer: unknown; answeredAt: string }>;
  purchase: null | {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    amountCents: number | null;
    currency: string | null;
    paidAt: string | null;
  };
}

export type Range = "24h" | "7d" | "30d";

interface RawSessionRow {
  id: string;
  state: "in_progress" | "paid" | "completed" | "abandoned";
  currentPageId: string | null;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  utmJson: Record<string, unknown>;
}

interface RawAnswerRow {
  pageId: string;
  questionId: string;
  answer: unknown;
  answeredAt: string;
}

function rangeToWindow(range: Range): number {
  const day = 86_400_000;
  if (range === "24h") return day;
  if (range === "7d") return 7 * day;
  return 30 * day;
}

// The server's session list endpoint exposes raw rows + limit/offset paging
// (no range param, no stats). We slice in-memory by `startedAt >= now - range`
// and aggregate the KPI block client-side. This is intentional — until the
// API gets a dedicated stats endpoint, the dashboard derives them on read.
function computeStats(rows: RawSessionRow[], windowMs: number): FunnelSessionsStatsDto {
  const cutoff = Date.now() - windowMs;
  const inWindow = rows.filter((r) => new Date(r.startedAt).getTime() >= cutoff);
  const started = inWindow.length;
  if (started === 0) {
    return { started: 0, completionRate: 0, paywallViewRate: 0, paidConversion: 0, medianDurationMs: null };
  }
  const completed = inWindow.filter((r) => r.state === "completed" || r.state === "paid").length;
  const paid = inWindow.filter((r) => r.state === "paid").length;
  // Without server-side payment-event correlation the paywall rate is
  // approximated as "reached a terminal state" — the server can refine it
  // when the funnel analytics aggregator lands.
  const reachedTerminal = completed;
  const durations = inWindow
    .filter((r) => r.completedAt)
    .map((r) => new Date(r.completedAt!).getTime() - new Date(r.startedAt).getTime())
    .sort((a, b) => a - b);
  const medianDurationMs = durations.length === 0 ? null : durations[Math.floor(durations.length / 2)];
  return {
    started,
    completionRate: completed / started,
    paywallViewRate: reachedTerminal / started,
    paidConversion: paid / started,
    medianDurationMs,
  };
}

function toRow(r: RawSessionRow): FunnelSessionRowDto {
  return {
    id: r.id,
    startedAt: r.startedAt,
    lastActivityAt: r.lastActivityAt,
    state: r.state,
    currentPageId: r.currentPageId,
    utmSource: ((r.utmJson as { source?: string | null } | null)?.source as string | null) ?? null,
    answersCount: 0,
  };
}

@injectable()
export class FunnelSessionsApi {
  async list(
    projectId: string,
    funnelId: string,
    range: Range,
    signal?: AbortSignal,
  ): Promise<{ sessions: FunnelSessionRowDto[]; stats: FunnelSessionsStatsDto }> {
    const result = await unwrap<{ sessions: RawSessionRow[] }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].sessions.$get(
        { param: { projectId, funnelId }, query: { limit: 200 as unknown as never } },
        { init: { signal } },
      ),
    );
    const windowMs = rangeToWindow(range);
    const cutoff = Date.now() - windowMs;
    const inRange = result.sessions.filter((r) => new Date(r.startedAt).getTime() >= cutoff);
    return {
      sessions: inRange.map(toRow),
      stats: computeStats(result.sessions, windowMs),
    };
  }

  async detail(
    projectId: string,
    funnelId: string,
    sessionId: string,
  ): Promise<FunnelSessionDetailDto> {
    const result = await unwrap<{ session: RawSessionRow; answers: RawAnswerRow[] }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].sessions[":sessionId"].$get({
        param: { projectId, funnelId, sessionId },
      }),
    );
    return {
      ...toRow(result.session),
      answersCount: result.answers.length,
      answers: result.answers,
      purchase: null,
    };
  }
}
