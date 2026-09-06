import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { validate } from "../../lib/validate";
import { ok } from "../../lib/response";
import { queryAnalytics } from "../../lib/clickhouse";
import { validateCadence } from "../../services/leaderboards/cadence";
import { queryStandings } from "../../services/leaderboards/standings-query";
import { isUniqueViolationOf } from "../../lib/pg-errors";

// =============================================================
// Dashboard: Leaderboards (Plan 3 §B.2, ROADMAP §12 item 3)
// =============================================================
//
// Two ad-hoc, day-range rollups over the ClickHouse analytics tables:
//
//   GET /dashboard/projects/:projectId/leaderboards/top-spenders
//     Sum of `amountUsd` from `raw_revenue_events` per subscriber.
//
//   GET /dashboard/projects/:projectId/leaderboards/top-consumers
//     Sum of debited credits (signed-negative `amount`) from
//     `raw_credit_ledger` per subscriber.
//
// Both queries require an inclusive ISO-8601 day range (`from`,
// `to`) and accept an optional `limit` (default 10, max 100).
//
// Freshness budget (documented for ops): ≤2s p99 from the outbox
// dispatcher publish until the row contributes to the rollup. Set
// by the Kafka Engine consumer + the SummingMergeTree merge cadence;
// `mv_credit_consumption_daily_target` aggregates per (project, day),
// not per subscriber, so subscriber-grain rollups go directly
// against `raw_credit_ledger FINAL`.
//
// Plus configured, season-based leaderboards (Task 1-4 of the
// leaderboard-seasons plan) CRUD + read surface:
//
//   GET    /                          list configured leaderboards
//   POST   /                          create                (leaderboards:write)
//   GET    /:id                       single
//   PATCH  /:id                       update                (leaderboards:write)
//   DELETE /:id                       delete                (leaderboards:write)
//   GET    /:id/seasons               season history
//   GET    /:id/current               live standings for the ACTIVE season
//   GET    /seasons/:seasonId/standings   frozen snapshot of a CLOSED (or
//                                          ACTIVE) season, keyed by season id
//
// `/:id/current` calls the SAME `queryStandings` the season-scheduler uses
// to freeze a season's archive (Task 3) — never a second copy of that SQL,
// or the live view and the stored archive could disagree.
//
// `/seasons/:seasonId/standings` is keyed by season id, not project id: it
// resolves the season, then its leaderboard, and authorises against THAT
// leaderboard's own `projectId` — never the path's `:projectId`, which can
// legitimately differ (a caller guessing/holding a seasonId from another
// project must not be able to read its frozen standings just because they
// also happen to be a member of some OTHER project named in the URL).

const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const MIN_ENTRY_LIMIT = 1;
const MAX_ENTRY_LIMIT = 1000;
const MAX_IDENTIFIER_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const DEFAULT_TIMEZONE = "UTC";

// Unique INDEX name from migration 0121 (packages/db/src/drizzle/schema.ts
// `leaderboards.projectIdIdentifierKey`). Postgres reports the index name
// in the unique_violation error's `constraint` field, same as the
// `uniqueIndex(...)` pattern `custom-domains.ts` already matches on.
const LEADERBOARD_IDENTIFIER_UNIQUE = "leaderboards_projectId_identifier_key";

const leaderboardQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .superRefine((v, ctx) => {
    const fromMs = new Date(v.from).getTime();
    const toMs = new Date(v.to).getTime();
    if (fromMs > toMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be <= to",
      });
      return;
    }
    if ((toMs - fromMs) / DAY_MS > MAX_WINDOW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window exceeds ${MAX_WINDOW_DAYS} days`,
      });
    }
  });

interface TopSpenderRow {
  subscriberId: string;
  totalUsd: string;
  eventCount: string;
}

interface TopConsumerRow {
  subscriberId: string;
  debited: string;
  eventCount: string;
}

// -------------------------------------------------------------
// Configured, season-based leaderboards
// -------------------------------------------------------------

const leaderboardMetricSchema = z.enum(["TOP_SPENDERS", "TOP_CONSUMERS"]);
const leaderboardCadenceSchema = z.enum(["WEEKLY", "MONTHLY", "CUSTOM"]);

const createLeaderboardBodySchema = z.object({
  identifier: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  metric: leaderboardMetricSchema,
  // Only meaningful for TOP_CONSUMERS. Absent/null = every currency.
  currencyId: z.string().min(1).nullable().optional(),
  cadence: leaderboardCadenceSchema,
  customPeriodDays: z.number().int().positive().nullable().optional(),
  timezone: z.string().min(1).optional(),
  entryLimit: z.number().int().min(MIN_ENTRY_LIMIT).max(MAX_ENTRY_LIMIT).optional(),
  // ISO-8601 instant. Defaults to "now" — only CUSTOM cadence actually
  // anchors its period boundaries on this value; WEEKLY/MONTHLY ignore it.
  anchorAt: z.string().datetime().optional(),
  isEnabled: z.boolean().optional(),
});

const updateLeaderboardBodySchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  currencyId: z.string().min(1).nullable().optional(),
  entryLimit: z.number().int().min(MIN_ENTRY_LIMIT).max(MAX_ENTRY_LIMIT).optional(),
  timezone: z.string().min(1).optional(),
  isEnabled: z.boolean().optional(),
});

/**
 * Whether the ICU/Intl implementation on this runtime recognises `tz` as a
 * timezone name. An unrecognised zone must be rejected here, at the write —
 * left unchecked, it would instead throw deep inside the scheduler's
 * boundary maths (services/leaderboards/cadence.ts), far from the request
 * that set it, and stuck on a leaderboard nothing else can fix from the API.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function requireProjectId(c: { req: { param: (k: string) => string | undefined } }): string {
  const projectId = c.req.param("projectId");
  if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
  return projectId;
}

function requireLeaderboardId(c: { req: { param: (k: string) => string | undefined } }): string {
  const id = c.req.param("id");
  if (!id) throw new HTTPException(400, { message: "Missing id" });
  return id;
}

export const leaderboardsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/top-spenders", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    let query: z.infer<typeof leaderboardQuerySchema>;
    try {
      query = leaderboardQuerySchema.parse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      });
    } catch (err) {
      throw new HTTPException(400, {
        message:
          err instanceof z.ZodError
            ? err.errors[0]?.message ?? "Invalid query parameters"
            : "Invalid query parameters",
      });
    }

    const rows = await queryAnalytics<TopSpenderRow>(
      projectId,
      `
        SELECT
          subscriberId,
          toString(sum(amountUsd))    AS totalUsd,
          toString(count())            AS eventCount
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND eventDate >= {from:Date}
          AND eventDate <= {to:Date}
        GROUP BY subscriberId
        ORDER BY sum(amountUsd) DESC, subscriberId ASC
        LIMIT {limit:UInt32}
      `,
      {
        from: query.from.slice(0, 10),
        to: query.to.slice(0, 10),
        limit: query.limit,
      },
    );

    return c.json(
      ok({
        from: query.from,
        to: query.to,
        entries: rows.map((r) => ({
          subscriberId: r.subscriberId,
          totalUsd: r.totalUsd,
          eventCount: Number(r.eventCount),
        })),
      }),
    );
  })
  .get("/top-consumers", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    let query: z.infer<typeof leaderboardQuerySchema>;
    try {
      query = leaderboardQuerySchema.parse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      });
    } catch (err) {
      throw new HTTPException(400, {
        message:
          err instanceof z.ZodError
            ? err.errors[0]?.message ?? "Invalid query parameters"
            : "Invalid query parameters",
      });
    }

    const rows = await queryAnalytics<TopConsumerRow>(
      projectId,
      `
        SELECT
          subscriberId,
          toString(sumIf(-amount, amount < 0)) AS debited,
          toString(countIf(amount < 0))         AS eventCount
        FROM rovenue.raw_credit_ledger FINAL
        WHERE projectId = {projectId:String}
          AND toDate(createdAt) >= {from:Date}
          AND toDate(createdAt) <= {to:Date}
        GROUP BY subscriberId
        HAVING sumIf(-amount, amount < 0) > 0
        ORDER BY sumIf(-amount, amount < 0) DESC, subscriberId ASC
        LIMIT {limit:UInt32}
      `,
      {
        from: query.from.slice(0, 10),
        to: query.to.slice(0, 10),
        limit: query.limit,
      },
    );

    return c.json(
      ok({
        from: query.from,
        to: query.to,
        entries: rows.map((r) => ({
          subscriberId: r.subscriberId,
          debited: r.debited,
          eventCount: Number(r.eventCount),
        })),
      }),
    );
  })
  // ----- GET /  (list configured leaderboards) -----
  .get("/", async (c) => {
    const projectId = requireProjectId(c);
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const leaderboards = await drizzle.leaderboardRepo.listLeaderboards(
      drizzle.db,
      projectId,
    );
    return c.json(ok({ leaderboards }));
  })
  // ----- POST / (create) -----
  .post("/", validate("json", createLeaderboardBodySchema), async (c) => {
    const projectId = requireProjectId(c);
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "leaderboards:write");
    const body = c.req.valid("json");

    // validateCadence is the primary defence: the CHECK constraint backing
    // the CUSTOM rule (migration 0121) is only the backstop. Without this,
    // an invalid combination surfaces as a raw constraint violation instead
    // of a clean 400.
    const cadenceError = validateCadence(body.cadence, body.customPeriodDays ?? null);
    if (cadenceError !== null) {
      throw new HTTPException(400, { message: cadenceError });
    }

    const timezone = body.timezone ?? DEFAULT_TIMEZONE;
    if (!isValidTimezone(timezone)) {
      throw new HTTPException(400, {
        message: `Unrecognised timezone: ${timezone}`,
      });
    }

    try {
      const leaderboard = await drizzle.leaderboardRepo.createLeaderboard(
        drizzle.db,
        {
          projectId,
          identifier: body.identifier,
          name: body.name,
          metric: body.metric,
          currencyId: body.currencyId ?? null,
          cadence: body.cadence,
          customPeriodDays: body.customPeriodDays ?? null,
          timezone,
          entryLimit: body.entryLimit,
          anchorAt: body.anchorAt ? new Date(body.anchorAt) : new Date(),
          isEnabled: body.isEnabled,
        },
      );
      return c.json(ok({ leaderboard }));
    } catch (err) {
      // Drizzle wraps the driver error as DrizzleQueryError, whose
      // `.message` is just "Failed query: <sql>\nparams: <params>" — it
      // never contains the word "unique". Matching on message text is
      // therefore dead code: the real Postgres error (code 23505 + the
      // constraint name) sits one level down on `.cause`, which is what
      // `isUniqueViolationOf` walks. See lib/pg-errors.ts and
      // custom-domains.ts for the same trap having already been found
      // once in this codebase.
      if (isUniqueViolationOf(err, LEADERBOARD_IDENTIFIER_UNIQUE)) {
        throw new HTTPException(409, {
          message: `Leaderboard identifier already in use: ${body.identifier}`,
        });
      }
      throw err;
    }
  })
  // ----- GET /seasons/:seasonId/standings (frozen snapshot) -----
  //
  // Keyed by season id, NOT project id: resolve the season, then its
  // leaderboard, then authorise against THAT leaderboard's own projectId.
  // (Placed here, ahead of "/:id", purely for reading order next to the
  // other season-shaped routes -- Hono's router matches by segment count,
  // so this 3-segment path can never collide with the 1- or 2-segment
  // ":id" routes regardless of registration order.)
  .get("/seasons/:seasonId/standings", async (c) => {
    const seasonId = c.req.param("seasonId");
    if (!seasonId) {
      throw new HTTPException(400, { message: "Missing seasonId" });
    }
    const user = c.get("user");

    const season = await drizzle.leaderboardRepo.findSeasonById(
      drizzle.db,
      seasonId,
    );
    if (!season) {
      throw new HTTPException(404, { message: "Season not found" });
    }
    const leaderboard = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      season.leaderboardId,
    );
    if (!leaderboard) {
      throw new HTTPException(404, { message: "Season not found" });
    }

    // Never the path's :projectId -- the two can differ, and the
    // leaderboard's own value is the only correct one to check.
    await assertProjectAccess(
      leaderboard.projectId,
      user.id,
      MemberRole.CUSTOMER_SUPPORT,
    );

    const standings = await drizzle.leaderboardRepo.listStandings(
      drizzle.db,
      season.id,
    );
    return c.json(ok({ season, standings }));
  })
  // ----- GET /:id -----
  .get("/:id", async (c) => {
    const projectId = requireProjectId(c);
    const id = requireLeaderboardId(c);
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const leaderboard = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      id,
    );
    if (!leaderboard || leaderboard.projectId !== projectId) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }
    return c.json(ok({ leaderboard }));
  })
  // ----- GET /:id/seasons -----
  .get("/:id/seasons", async (c) => {
    const projectId = requireProjectId(c);
    const id = requireLeaderboardId(c);
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const leaderboard = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      id,
    );
    if (!leaderboard || leaderboard.projectId !== projectId) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }

    const seasons = await drizzle.leaderboardRepo.listSeasons(
      drizzle.db,
      leaderboard.id,
    );
    return c.json(ok({ seasons }));
  })
  // ----- GET /:id/current (live standings for the ACTIVE season) -----
  //
  // Delegates to the SAME queryStandings the season-scheduler uses to
  // freeze a season's archive (Task 3) -- never a second copy of that
  // SQL, or the live view and the stored archive could disagree.
  //
  // A leaderboard whose first season hasn't opened yet is a valid state
  // (the scheduler sweeps on its own interval), so this returns an empty
  // envelope rather than a 404 -- the dashboard renders an empty state.
  .get("/:id/current", async (c) => {
    const projectId = requireProjectId(c);
    const id = requireLeaderboardId(c);
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const leaderboard = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      id,
    );
    if (!leaderboard || leaderboard.projectId !== projectId) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }

    const season = await drizzle.leaderboardRepo.findActiveSeason(
      drizzle.db,
      leaderboard.id,
    );
    if (!season) {
      return c.json(ok({ season: null, entries: [] }));
    }

    const entries = await queryStandings({
      projectId: leaderboard.projectId,
      metric: leaderboard.metric,
      currencyId: leaderboard.currencyId,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      limit: leaderboard.entryLimit,
    });

    return c.json(ok({ season, entries }));
  })
  // ----- PATCH /:id -----
  .patch("/:id", validate("json", updateLeaderboardBodySchema), async (c) => {
    const projectId = requireProjectId(c);
    const id = requireLeaderboardId(c);
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "leaderboards:write");
    const body = c.req.valid("json");

    // updateLeaderboard returns null both for "no such row" AND for an
    // empty patch (nothing to set) -- the route is the only place that
    // can tell those apart, so it must reject the empty-body case itself
    // rather than let it fall through and misreport as a 404 on a row
    // that actually exists.
    if (Object.keys(body).length === 0) {
      throw new HTTPException(400, { message: "No fields to update" });
    }

    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      throw new HTTPException(400, {
        message: `Unrecognised timezone: ${body.timezone}`,
      });
    }

    const existing = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      id,
    );
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }

    const leaderboard = await drizzle.leaderboardRepo.updateLeaderboard(
      drizzle.db,
      id,
      body,
    );
    if (!leaderboard) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }
    return c.json(ok({ leaderboard }));
  })
  // ----- DELETE /:id -----
  .delete("/:id", async (c) => {
    const projectId = requireProjectId(c);
    const id = requireLeaderboardId(c);
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "leaderboards:write");

    const existing = await drizzle.leaderboardRepo.findLeaderboardById(
      drizzle.db,
      id,
    );
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Leaderboard not found" });
    }

    await drizzle.leaderboardRepo.deleteLeaderboard(drizzle.db, id);
    return c.json(ok({ deleted: true }));
  });
