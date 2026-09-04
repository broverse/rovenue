# §12.3 Leaderboard seasons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn leaderboards from two ad-hoc ClickHouse date-range queries into
configured objects with recurring seasons that open, close and archive their
final standings automatically.

**Architecture:** Three new Postgres tables (`leaderboards`,
`leaderboard_seasons`, `leaderboard_standings`) plus a repeatable BullMQ
worker modelled on `experiment-scheduler.ts`. At each boundary the worker
queries ClickHouse **first**, then claims + snapshots + closes + opens the
next season in one Postgres transaction, so a ClickHouse outage leaves nothing
half-written. A partial unique index makes "two replicas open two live
seasons" a database error rather than a data bug.

**Tech Stack:** Drizzle + Postgres, ClickHouse, BullMQ, `Intl` for timezone
math (this repo deliberately does not depend on luxon or date-fns — see
`apps/api/src/services/notifications/tz.ts`), Vitest (against the ambient
docker-compose stack).

**Spec:** `docs/superpowers/specs/2026-09-04-roadmap-12-feature-breadth-design.md`
(Sub-project 3)

## Global Constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. `LEADERBOARD_SNAPSHOT_SETTLE_MS`,
  `LEADERBOARD_DEFAULT_ENTRY_LIMIT`, `LEADERBOARD_SWEEP_INTERVAL_MS` and the
  cadence→duration table are named exported constants. The cadence table is
  structured data, not a magic value — keep it a table.
- **No new date/timezone dependency.** Use `Intl.DateTimeFormat.formatToParts`
  the way `apps/api/src/services/notifications/tz.ts` does.
- Migrations: re-check the current head immediately before generating.
- New enums must be re-exported from `packages/db/src/drizzle/schema.ts`.
- The worker declares Prometheus counters in `apps/api/src/lib/metrics.ts`.
- Dashboard strings go through `t()` keys, looked up via an explicit map —
  never `t(\`...${enumValue}\`)`.
- Raw `sql` must qualify columns (`"leaderboard_seasons"."id"`).
- Throttled test runs: `nice -n 19 npx vitest run --maxWorkers=2`.
- **Do not modify** the existing `top-spenders` / `top-consumers` endpoints or
  the dashboard view that consumes them. They stay as they are.
- **Verify every wire/serialisation shape against the PRODUCING code before
  trusting a test fixture.** A fixture invented from a plan's prose can carry
  the same wrong field name as the parser it exercises, in which case the test
  passes green while the feature is dead in production. This already happened
  once in this batch (12.4's Kafka envelope: the plan said `outboxEventId`, the
  wire says `eventId`). Open the emitter and read it.
  For this plan the shapes at risk are the ClickHouse result rows — check the
  existing `top-spenders` / `top-consumers` handlers for the real column names.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/drizzle/enums.ts` | `leaderboardMetric`, `leaderboardCadence`, `leaderboardSeasonStatus` |
| `packages/db/src/drizzle/schema.ts` | three tables + enum re-exports |
| `packages/db/src/drizzle/repositories/leaderboards.ts` | all three tables' reads/writes, including the conditional claim |
| `apps/api/src/services/leaderboards/cadence.ts` | boundary arithmetic (pure, no I/O); imports its cadence type from the enum |
| `apps/api/src/services/leaderboards/standings-query.ts` | the ONE ClickHouse query, shared by worker and `/current` |
| `apps/api/src/workers/leaderboard-scheduler.ts` | the sweep |
| `apps/api/src/routes/dashboard/leaderboards.ts` | CRUD + seasons + standings + current |
| `apps/api/src/lib/metrics.ts` | counters |

---

### Task 1: Schema and repository

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/src/drizzle/repositories/leaderboards.ts`
- Modify: `packages/db/src/drizzle/index.ts` (barrel export)
- Create: `packages/db/drizzle/migrations/01xx_leaderboard_seasons.sql` (generated + hand-added partial index)

**Interfaces:**
- Produces enums `leaderboardMetric` (`TOP_SPENDERS`, `TOP_CONSUMERS`),
  `leaderboardCadence` (`WEEKLY`, `MONTHLY`, `CUSTOM`),
  `leaderboardSeasonStatus` (`ACTIVE`, `CLOSED`).
- Produces tables `leaderboards`, `leaderboardSeasons`,
  `leaderboardStandings` with the columns in the spec.
- Produces repository functions:
  - `listLeaderboards(db, projectId): Promise<Leaderboard[]>`
  - `findLeaderboardById(db, id): Promise<Leaderboard | null>`
  - `createLeaderboard(db, input): Promise<Leaderboard>`
  - `updateLeaderboard(db, id, patch): Promise<Leaderboard | null>`
  - `deleteLeaderboard(db, id): Promise<void>`
  - `findEnabledLeaderboardsWithoutActiveSeason(db): Promise<Leaderboard[]>`
  - `findDueSeasons(db, closeBefore: Date): Promise<LeaderboardSeason[]>`
  - `openSeason(db, input): Promise<LeaderboardSeason | null>` — returns null
    on a unique violation rather than throwing
  - `claimSeasonForClose(db, seasonId, now): Promise<LeaderboardSeason | null>`
  - `insertStandings(db, seasonId, rows): Promise<void>`
  - `listSeasons(db, leaderboardId): Promise<LeaderboardSeason[]>`
  - `findActiveSeason(db, leaderboardId): Promise<LeaderboardSeason | null>`
  - `listStandings(db, seasonId): Promise<LeaderboardStanding[]>`

- [ ] **Step 1: Add the enums**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const leaderboardMetric = pgEnum("LeaderboardMetric", [
  "TOP_SPENDERS",
  "TOP_CONSUMERS",
]);

export const leaderboardCadence = pgEnum("LeaderboardCadence", [
  "WEEKLY",
  "MONTHLY",
  "CUSTOM",
]);

export const leaderboardSeasonStatus = pgEnum("LeaderboardSeasonStatus", [
  "ACTIVE",
  "CLOSED",
]);
```

- [ ] **Step 2: Add the tables**

In `packages/db/src/drizzle/schema.ts`, import the three enums and add:

```ts
// =============================================================
// leaderboards (configured, season-based)
// =============================================================

export const leaderboards = pgTable(
  "leaderboards",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    metric: leaderboardMetric("metric").notNull(),
    // Only meaningful for TOP_CONSUMERS. Null = every currency, which is
    // what the existing ad-hoc endpoint does.
    currencyId: text("currencyId").references(() => virtualCurrencies.id, {
      onDelete: "set null",
    }),
    cadence: leaderboardCadence("cadence").notNull(),
    customPeriodDays: integer("customPeriodDays"),
    // IANA name. Season boundaries roll at local midnight in this zone.
    timezone: text("timezone").notNull().default("UTC"),
    entryLimit: integer("entryLimit").notNull().default(100),
    anchorAt: timestamp("anchorAt", { withTimezone: true }).notNull(),
    isEnabled: boolean("isEnabled").notNull().default(true),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex("leaderboards_projectId_identifier_key").on(
      t.projectId,
      t.identifier,
    ),
    projectIdIdx: index("leaderboards_projectId_idx").on(t.projectId),
  }),
);

export const leaderboardSeasons = pgTable(
  "leaderboard_seasons",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    leaderboardId: text("leaderboardId")
      .notNull()
      .references(() => leaderboards.id, { onDelete: "cascade" }),
    seasonNumber: integer("seasonNumber").notNull(),
    startsAt: timestamp("startsAt", { withTimezone: true }).notNull(),
    /** Exclusive. */
    endsAt: timestamp("endsAt", { withTimezone: true }).notNull(),
    status: leaderboardSeasonStatus("status").notNull().default("ACTIVE"),
    closedAt: timestamp("closedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leaderboardIdSeasonNumberKey: uniqueIndex(
      "leaderboard_seasons_leaderboardId_seasonNumber_key",
    ).on(t.leaderboardId, t.seasonNumber),
    statusEndsAtIdx: index("leaderboard_seasons_status_endsAt_idx").on(
      t.status,
      t.endsAt,
    ),
  }),
);

export const leaderboardStandings = pgTable(
  "leaderboard_standings",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    seasonId: text("seasonId")
      .notNull()
      .references(() => leaderboardSeasons.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    // Deliberately NOT a foreign key: standings are a historical snapshot,
    // and a closed season's numbers must not change or vanish because a
    // subscriber row was later removed.
    subscriberId: text("subscriberId").notNull(),
    // Numeric as text: USD sums and large credit totals must not go
    // through a float.
    score: text("score").notNull(),
    eventCount: integer("eventCount").notNull(),
  },
  (t) => ({
    seasonIdRankKey: uniqueIndex("leaderboard_standings_seasonId_rank_key").on(
      t.seasonId,
      t.rank,
    ),
  }),
);

export type Leaderboard = typeof leaderboards.$inferSelect;
export type NewLeaderboard = typeof leaderboards.$inferInsert;
export type LeaderboardSeason = typeof leaderboardSeasons.$inferSelect;
export type LeaderboardStanding = typeof leaderboardStandings.$inferSelect;
```

Add all three enums to the re-export block at the bottom of `schema.ts`.

- [ ] **Step 3: Generate the migration and hand-add the partial index**

```bash
ls packages/db/drizzle/migrations/*.sql | tail -1   # confirm the head
pnpm db:migrate:generate
```

drizzle-kit cannot express a partial unique index, so append by hand to the
generated file:

```sql
-- At most one ACTIVE season per leaderboard. This constraint is what makes
-- "two replicas open two live seasons" a database error instead of a data
-- corruption, with no application-level locking.
CREATE UNIQUE INDEX "leaderboard_seasons_one_active_idx"
  ON "leaderboard_seasons" ("leaderboardId")
  WHERE "status" = 'ACTIVE';

-- customPeriodDays is required for CUSTOM and forbidden otherwise.
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_custom_period_days_check"
  CHECK (
    ("cadence" = 'CUSTOM' AND "customPeriodDays" IS NOT NULL AND "customPeriodDays" > 0)
    OR ("cadence" <> 'CUSTOM' AND "customPeriodDays" IS NULL)
  );
```

Because these are hand-written, drizzle-kit's next `generate` may try to drop
them. Check the following generated migration and trim any such statement —
this has bitten the repo before.

- [ ] **Step 4: Write the repository**

Create `packages/db/src/drizzle/repositories/leaderboards.ts` with the
functions listed under Interfaces. Two need care:

```ts
/**
 * Open a season. Returns null when the partial unique index rejects the
 * insert — i.e. another replica opened one first. That is an expected
 * outcome under concurrency, not an error.
 */
export async function openSeason(
  db: Db,
  input: {
    leaderboardId: string;
    seasonNumber: number;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<LeaderboardSeason | null> {
  const rows = await db
    .insert(leaderboardSeasons)
    .values({ ...input, status: "ACTIVE" })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/**
 * Conditional claim: never a SELECT followed by an UPDATE. Two replicas
 * sweeping at once cannot both close the same season, because only one
 * UPDATE can see status = 'ACTIVE'.
 */
export async function claimSeasonForClose(
  db: Db,
  seasonId: string,
  now: Date,
): Promise<LeaderboardSeason | null> {
  const rows = await db
    .update(leaderboardSeasons)
    .set({ status: "CLOSED", closedAt: now })
    .where(
      and(
        eq(leaderboardSeasons.id, seasonId),
        eq(leaderboardSeasons.status, "ACTIVE"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
```

`onConflictDoNothing()` covers both unique indexes on the table. Add the
namespace to `packages/db/src/drizzle/index.ts`:
`export * as leaderboardRepo from "./repositories/leaderboards";`

- [ ] **Step 5: Type-check and commit**

```bash
nice -n 19 npx tsc --noEmit -p packages/db
```

```bash
git add packages/db/src packages/db/drizzle/migrations
git commit -m "feat(db): leaderboards, seasons and standings

A partial unique index on (leaderboardId) WHERE status='ACTIVE' makes a
second live season a database error rather than a data bug."
```

---

### Task 2: Cadence boundary arithmetic

No database and no I/O — every later task depends on getting season windows
right, and this is the only genuinely subtle part. It runs after the schema so
it can import the cadence union from the enum rather than redeclare it: two
hand-maintained copies of the same three values, in different packages with
nothing pinning them equal, is how a value added to the enum later silently
fails to exist for the cadence math.

**Files:**
- Create: `apps/api/src/services/leaderboards/cadence.ts`
- Create: `apps/api/src/services/leaderboards/cadence.test.ts`

**Interfaces:**
- Consumes: `LeaderboardCadence` — `import type { LeaderboardCadence } from
  "@rovenue/db"`, the type inferred from Task 1's `leaderboardCadence` pgEnum.
  Do NOT redeclare the union here. A type-only import is erased at runtime and
  cannot create a package cycle.
- Produces: `export interface SeasonWindow { startsAt: Date; endsAt: Date }`
  — `endsAt` is **exclusive**.
- Produces: `export function seasonWindowContaining(instant: Date, cadence:
  LeaderboardCadence, timezone: string, customPeriodDays: number | null,
  anchorAt: Date): SeasonWindow`.
- Produces: `export function nextSeasonWindow(previous: SeasonWindow, cadence:
  LeaderboardCadence, timezone: string, customPeriodDays: number | null,
  anchorAt: Date): SeasonWindow` — always starts exactly at
  `previous.endsAt`.
- Produces: `export function validateCadence(cadence: LeaderboardCadence,
  customPeriodDays: number | null): string | null` — returns an error message
  or null.

**Rules:**
- `WEEKLY` boundaries fall at local **Monday 00:00** in `timezone`.
- `MONTHLY` boundaries fall at local **day-1 00:00** in `timezone`.
- `CUSTOM` counts `customPeriodDays` from `anchorAt`, in whole local days.
- `customPeriodDays` must be a positive integer for `CUSTOM` and must be null
  otherwise.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/leaderboards/cadence.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  nextSeasonWindow,
  seasonWindowContaining,
  validateCadence,
} from "./cadence";
import type { LeaderboardCadence } from "@rovenue/db";

const ISTANBUL = "Europe/Istanbul";   // UTC+3, no DST since 2016
const BERLIN = "Europe/Berlin";       // UTC+1 / UTC+2, DST
const UTC = "UTC";
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");

describe("validateCadence", () => {
  test("CUSTOM requires a positive customPeriodDays", () => {
    expect(validateCadence("CUSTOM", null)).not.toBeNull();
    expect(validateCadence("CUSTOM", 0)).not.toBeNull();
    expect(validateCadence("CUSTOM", -3)).not.toBeNull();
    expect(validateCadence("CUSTOM", 14)).toBeNull();
  });

  test("non-CUSTOM rejects customPeriodDays", () => {
    expect(validateCadence("WEEKLY", 7)).not.toBeNull();
    expect(validateCadence("MONTHLY", 30)).not.toBeNull();
    expect(validateCadence("WEEKLY", null)).toBeNull();
    expect(validateCadence("MONTHLY", null)).toBeNull();
  });
});

describe("seasonWindowContaining — WEEKLY", () => {
  test("a Wednesday resolves to that week's Monday 00:00 local", () => {
    // 2026-09-02 is a Wednesday.
    const w = seasonWindowContaining(
      new Date("2026-09-02T12:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );

    // Monday 2026-08-31 00:00 in UTC+3 is 2026-08-30T21:00Z.
    expect(w.startsAt.toISOString()).toBe("2026-08-30T21:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-09-06T21:00:00.000Z");
  });

  test("Saturday evening local is inside the week, not cut off by UTC", () => {
    // 2026-09-05T22:00Z is Sunday 01:00 in Istanbul, still in the week
    // that began Monday 2026-08-31. A UTC-only boundary would have
    // already rolled over.
    const w = seasonWindowContaining(
      new Date("2026-09-05T22:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-08-30T21:00:00.000Z");
  });

  test("a DST transition does not shorten or lengthen the local week", () => {
    // Berlin leaves DST on 2026-10-25. The window must still start and
    // end at local Monday 00:00, so its UTC length is 169 hours, not 168.
    const w = seasonWindowContaining(
      new Date("2026-10-21T12:00:00.000Z"),
      "WEEKLY",
      BERLIN,
      null,
      ANCHOR,
    );
    const hours = (w.endsAt.getTime() - w.startsAt.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });
});

describe("seasonWindowContaining — MONTHLY", () => {
  test("mid-month resolves to the 1st at 00:00 local", () => {
    const w = seasonWindowContaining(
      new Date("2026-09-17T08:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a 31-day month rolls to the next 1st, not to day 31", () => {
    // Anchoring off a 31st is the classic month-arithmetic bug: naive
    // +1 month from Jan 31 lands on Mar 3.
    const w = seasonWindowContaining(
      new Date("2026-01-31T12:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      new Date("2026-01-31T00:00:00.000Z"),
    );
    expect(w.startsAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("seasonWindowContaining — CUSTOM", () => {
  test("counts whole periods from the anchor", () => {
    const w = seasonWindowContaining(
      new Date("2026-01-16T00:00:00.000Z"),
      "CUSTOM",
      UTC,
      14,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-01-29T00:00:00.000Z");
  });
});

describe("nextSeasonWindow", () => {
  test("starts exactly where the previous one ended, leaving no gap", () => {
    const first = seasonWindowContaining(
      new Date("2026-09-02T12:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );
    const second = nextSeasonWindow(first, "WEEKLY", ISTANBUL, null, ANCHOR);

    // No event may fall between two seasons. This is what lets the
    // snapshot settle delay be safe: the next season already started.
    expect(second.startsAt.getTime()).toBe(first.endsAt.getTime());
    expect(second.endsAt.getTime()).toBeGreaterThan(second.startsAt.getTime());
  });

  test("chains across a month boundary without drift", () => {
    let w = seasonWindowContaining(
      new Date("2026-01-05T00:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      ANCHOR,
    );
    for (let i = 0; i < 13; i += 1) {
      const next = nextSeasonWindow(w, "MONTHLY", UTC, null, ANCHOR);
      expect(next.startsAt.getTime()).toBe(w.endsAt.getTime());
      w = next;
    }
    // 13 steps on from January 2026 is February 2027.
    expect(w.startsAt.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/leaderboards/cadence.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/leaderboards/cadence.ts`. Build it on two
`Intl`-based primitives, mirroring the approach in
`apps/api/src/services/notifications/tz.ts`:

```ts
// =============================================================
// Leaderboard cadence boundary arithmetic
// =============================================================
//
// Season boundaries are LOCAL: a weekly leaderboard for a Turkish app
// rolls at Monday 00:00 Istanbul time, not at UTC midnight, which would
// cut Sunday evening in half. All arithmetic happens on the local
// calendar and is converted back to a UTC instant for storage.
//
// No luxon, no date-fns: Node's Intl ships the full IANA database and
// this repo already does timezone work this way (services/notifications/tz.ts).

// The cadence union comes from the pgEnum (Task 1), never redeclared here.
import type { LeaderboardCadence } from "@rovenue/db";

export interface SeasonWindow {
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface LocalParts {
  year: number;
  month: number;   // 1-12
  day: number;     // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1 = Monday .. 7 = Sunday
}

// Implement:
//   localPartsIn(instant, timezone): LocalParts
//     via Intl.DateTimeFormat(timezone, { ...numeric fields, weekday: "short",
//     hour12: false }).formatToParts, with a cached formatter per timezone.
//
//   utcInstantForLocal(parts, timezone): Date
//     Local -> UTC has no direct Intl inverse. Use the standard two-pass
//     fixpoint: guess the instant as if the local parts were UTC, read the
//     zone's offset at that guess, subtract it, then re-read the offset at
//     the corrected instant and correct once more. Two passes is enough for
//     every real zone including DST edges; assert the second pass is stable
//     and throw if it is not, rather than returning a silently wrong instant.
//
// Then:
//   WEEKLY  -> back up to weekday 1, zero the time, that is startsAt;
//              endsAt is the same local wall-clock 7 local days later
//              (NOT startsAt + 7*MS_PER_DAY -- that is what breaks across DST).
//   MONTHLY -> set day = 1, zero the time; endsAt is day 1 of the next
//              month, carrying the year.
//   CUSTOM  -> floor((instant - anchorAt) / (customPeriodDays local days))
//              periods from the anchor.
```

Write the real implementation — the block above is the algorithm, not a
substitute for code. The DST test is the one that fails if `endsAt` is
computed by adding milliseconds instead of local days; treat it as the
specification.

```ts
export function validateCadence(
  cadence: LeaderboardCadence,
  customPeriodDays: number | null,
): string | null {
  if (cadence === "CUSTOM") {
    if (customPeriodDays === null || !Number.isInteger(customPeriodDays) || customPeriodDays <= 0) {
      return "customPeriodDays must be a positive integer when cadence is CUSTOM";
    }
    return null;
  }
  if (customPeriodDays !== null) {
    return `customPeriodDays must be null when cadence is ${cadence}`;
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/leaderboards/cadence.test.ts --maxWorkers=2
```

Expected: PASS (11 tests). The DST and 31st-of-the-month tests are the ones
most likely to fail first — do not weaken them.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/leaderboards/cadence.ts apps/api/src/services/leaderboards/cadence.test.ts
git commit -m "feat(leaderboards): local-calendar season boundary arithmetic

Boundaries are local, so a weekly season is 169 UTC hours across a DST
exit rather than silently losing an hour of standings."
```

---

### Task 3: The shared standings query

**Files:**
- Create: `apps/api/src/services/leaderboards/standings-query.ts`
- Create: `apps/api/src/services/leaderboards/standings-query.test.ts`

**Interfaces:**
- Produces: `export interface StandingRow { subscriberId: string; score:
  string; eventCount: number }`.
- Consumes: `LeaderboardMetric` — `import type { LeaderboardMetric } from
  "@rovenue/db"`, inferred from Task 1's `leaderboardMetric` pgEnum. Do not
  inline the `"TOP_SPENDERS" | "TOP_CONSUMERS"` union; same single-source rule
  as the cadence type.
- Produces: `export function buildStandingsQuery(metric: LeaderboardMetric,
  currencyId: string | null): { sql: string }` — pure, so the SQL shape is
  testable without ClickHouse.
- Produces: `export async function queryStandings(args: { projectId: string;
  metric; currencyId: string | null; startsAt: Date; endsAt: Date; limit:
  number }): Promise<StandingRow[]>`.

**Why one function:** the worker's frozen snapshot and the dashboard's
`/current` view must never be able to disagree in shape. Two copies of this
SQL is exactly how a live leaderboard ends up contradicting its own archive.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { buildStandingsQuery } from "./standings-query";

describe("buildStandingsQuery", () => {
  test("TOP_SPENDERS sums amountUsd from raw_revenue_events", () => {
    const { sql } = buildStandingsQuery("TOP_SPENDERS", null);
    expect(sql).toContain("rovenue.raw_revenue_events");
    expect(sql).toContain("amountUsd");
  });

  test("TOP_CONSUMERS sums debited credits from raw_credit_ledger", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).toContain("rovenue.raw_credit_ledger");
    expect(sql).toContain("amount < 0");
  });

  test("TOP_CONSUMERS scopes to one currency when given", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", "cur_1");
    expect(sql).toContain("{currencyId:String}");
  });

  test("TOP_CONSUMERS with no currency does not reference the parameter", () => {
    // Passing an unused parameter to ClickHouse is an error, not a no-op.
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).not.toContain("{currencyId:String}");
  });

  test("every query orders deterministically", () => {
    // Ties must break the same way in the frozen snapshot and in
    // /current, or a subscriber's rank appears to change on refresh.
    for (const metric of ["TOP_SPENDERS", "TOP_CONSUMERS"] as const) {
      expect(buildStandingsQuery(metric, null).sql).toContain(
        "subscriberId ASC",
      );
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/leaderboards/standings-query.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Lift the two SQL bodies verbatim from the existing `top-spenders` and
`top-consumers` handlers in `apps/api/src/routes/dashboard/leaderboards.ts` —
do not rewrite them — and parameterise the window on `startsAt`/`endsAt`
timestamps rather than dates, adding the optional `currencyId` filter. Note
the existing queries use `toDate(createdAt) >= {from:Date}`; seasons need
instant precision, so use `createdAt >= {startsAt:DateTime64(3)}` and
`createdAt < {endsAt:DateTime64(3)}` — half-open, matching `endsAt` being
exclusive. Call through `queryAnalytics` exactly as the routes do.

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/leaderboards/standings-query.test.ts --maxWorkers=2
```

Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/leaderboards/standings-query.ts apps/api/src/services/leaderboards/standings-query.test.ts
git commit -m "feat(leaderboards): one standings query for snapshot and live view"
```

---

### Task 4: The season scheduler worker

**Files:**
- Create: `apps/api/src/workers/leaderboard-scheduler.ts`
- Create: `apps/api/src/workers/leaderboard-scheduler.test.ts`
- Modify: `apps/api/src/lib/metrics.ts`
- Modify: wherever repeatable workers are registered (find with
  `grep -rn "EXPERIMENT_SCHEDULER_QUEUE_NAME" apps/api/src --include=*.ts | grep -v test`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `LEADERBOARD_SCHEDULER_QUEUE_NAME = "rovenue-leaderboard-scheduler"`.
- Produces: `export const LEADERBOARD_SNAPSHOT_SETTLE_MS = 5 * 60 * 1000`.
- Produces: `export const LEADERBOARD_SWEEP_INTERVAL_MS = 5 * 60 * 1000`.
- Produces: `export const LEADERBOARD_DEFAULT_ENTRY_LIMIT = 100`.
- Produces: `export async function sweepLeaderboardSeasons(now: Date, deps:
  SchedulerDeps): Promise<{ opened: number; closed: number; skipped: number }>`.
- Produces: `ensureLeaderboardScheduler(opts?: { autoStart?: boolean })`.
- Produces: counters `leaderboardSeasonsOpenedTotal`,
  `leaderboardSeasonsClosedTotal`, `leaderboardSeasonCloseSkippedTotal`
  (labelled `reason`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/leaderboard-scheduler.test.ts`, DI'ing every
dependency so the sweep logic is testable without infrastructure:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  LEADERBOARD_SNAPSHOT_SETTLE_MS,
  sweepLeaderboardSeasons,
} from "./leaderboard-scheduler";

const NOW = new Date("2026-09-07T00:10:00.000Z");

function season(overrides: Record<string, unknown> = {}) {
  return {
    id: "sea_1",
    leaderboardId: "lb_1",
    seasonNumber: 1,
    startsAt: new Date("2026-08-31T00:00:00.000Z"),
    endsAt: new Date("2026-09-07T00:00:00.000Z"),
    status: "ACTIVE",
    ...overrides,
  };
}

function leaderboard(overrides: Record<string, unknown> = {}) {
  return {
    id: "lb_1",
    projectId: "prj_1",
    metric: "TOP_SPENDERS",
    currencyId: null,
    cadence: "WEEKLY",
    customPeriodDays: null,
    timezone: "UTC",
    entryLimit: 100,
    anchorAt: new Date("2026-08-31T00:00:00.000Z"),
    isEnabled: true,
    ...overrides,
  };
}

let deps: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  deps = {
    findEnabledLeaderboardsWithoutActiveSeason: vi.fn(async () => []),
    findDueSeasons: vi.fn(async () => []),
    findLeaderboardById: vi.fn(async () => leaderboard()),
    queryStandings: vi.fn(async () => [
      { subscriberId: "sub_1", score: "42.0000", eventCount: 3 },
    ]),
    claimSeasonForClose: vi.fn(async () => season({ status: "CLOSED" })),
    insertStandings: vi.fn(async () => {}),
    openSeason: vi.fn(async () => season({ id: "sea_2", seasonNumber: 2 })),
    audit: vi.fn(async () => {}),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});

describe("sweepLeaderboardSeasons", () => {
  test("queries ClickHouse BEFORE claiming the season", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    const queryOrder = deps.queryStandings.mock.invocationCallOrder[0]!;
    const claimOrder = deps.claimSeasonForClose.mock.invocationCallOrder[0]!;

    // Claiming first would mean a ClickHouse outage leaves a season
    // marked CLOSED with no standings, recoverable only by a
    // compensating un-close. This ordering removes that state.
    expect(queryOrder).toBeLessThan(claimOrder);
  });

  test("a ClickHouse failure closes nothing at all", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.queryStandings.mockRejectedValue(new Error("clickhouse down"));

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.claimSeasonForClose).not.toHaveBeenCalled();
    expect(deps.insertStandings).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("a lost claim writes no standings and opens no next season", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.claimSeasonForClose.mockResolvedValue(null);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.insertStandings).not.toHaveBeenCalled();
    expect(deps.openSeason).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
  });

  test("a closed season opens the next one starting exactly at endsAt", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.openSeason).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaderboardId: "lb_1",
        seasonNumber: 2,
        startsAt: new Date("2026-09-07T00:00:00.000Z"),
      }),
    );
  });

  test("does not close a season before the settle delay has elapsed", async () => {
    // findDueSeasons is called with endsAt + settle <= now, so assert the
    // cutoff the worker actually passes down.
    await sweepLeaderboardSeasons(NOW, deps as never);

    const cutoff = deps.findDueSeasons.mock.calls[0]![1] as Date;
    expect(cutoff.getTime()).toBe(NOW.getTime() - LEADERBOARD_SNAPSHOT_SETTLE_MS);
  });

  test("standings are ranked 1..N in query order", async () => {
    deps.findDueSeasons.mockResolvedValue([season()]);
    deps.queryStandings.mockResolvedValue([
      { subscriberId: "sub_a", score: "99.0000", eventCount: 5 },
      { subscriberId: "sub_b", score: "42.0000", eventCount: 3 },
    ]);

    await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.insertStandings).toHaveBeenCalledWith(
      expect.anything(),
      "sea_1",
      [
        { rank: 1, subscriberId: "sub_a", score: "99.0000", eventCount: 5 },
        { rank: 2, subscriberId: "sub_b", score: "42.0000", eventCount: 3 },
      ],
    );
  });

  test("opens a first season for an enabled leaderboard that has none", async () => {
    deps.findEnabledLeaderboardsWithoutActiveSeason.mockResolvedValue([leaderboard()]);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(deps.openSeason).toHaveBeenCalled();
    expect(result.opened).toBe(1);
  });

  test("a rejected open (another replica won) is not an error", async () => {
    deps.findEnabledLeaderboardsWithoutActiveSeason.mockResolvedValue([leaderboard()]);
    deps.openSeason.mockResolvedValue(null);

    const result = await sweepLeaderboardSeasons(NOW, deps as never);

    expect(result.opened).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/workers/leaderboard-scheduler.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker**

Read `apps/api/src/workers/experiment-scheduler.ts` in full first and mirror
its structure: repeatable BullMQ job, own queue name, own repeatable job id,
a pure sweep function, `audit()` inside the transaction.

The close path must be, in this order:

```ts
// 1. Query FIRST. Nothing is written yet, so a failure is a plain retry.
let standings: StandingRow[];
try {
  standings = await deps.queryStandings({ ... });
} catch (err) {
  leaderboardSeasonCloseSkippedTotal.inc({ reason: "clickhouse" });
  log.warn("standings query failed, leaving season ACTIVE", { seasonId, err });
  skipped += 1;
  continue;
}

// 2. Then claim + snapshot + close + open next, all in ONE transaction.
const closed = await deps.transaction(async (tx) => {
  const claimedSeason = await deps.claimSeasonForClose(tx, season.id, now);
  if (!claimedSeason) return null;   // another replica won

  await deps.insertStandings(
    tx,
    claimedSeason.id,
    standings.map((row, index) => ({ rank: index + 1, ...row })),
  );
  await deps.audit({ ... });
  const next = nextSeasonWindow(...);
  await deps.openSeason(tx, {
    leaderboardId: season.leaderboardId,
    seasonNumber: season.seasonNumber + 1,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
  });
  return claimedSeason;
});
```

Add the counters to `apps/api/src/lib/metrics.ts`:

```ts
export const leaderboardSeasonsOpenedTotal = new Counter({
  name: "rovenue_leaderboard_seasons_opened_total",
  help: "Leaderboard seasons opened by the scheduler",
  registers: [registry],
});

export const leaderboardSeasonsClosedTotal = new Counter({
  name: "rovenue_leaderboard_seasons_closed_total",
  help: "Leaderboard seasons closed and snapshotted",
  registers: [registry],
});

// A lost claim is normal with multiple replicas. A sustained "clickhouse"
// rate means seasons are drifting past their boundary unclosed, which is
// otherwise invisible until someone notices stale standings.
export const leaderboardSeasonCloseSkippedTotal = new Counter({
  name: "rovenue_leaderboard_season_close_skipped_total",
  help: "Season closes abandoned, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/workers/leaderboard-scheduler.test.ts --maxWorkers=2
```

Expected: PASS (8 tests). The ordering test is the important one — if it
fails, the query/claim order is wrong, not the test.

- [ ] **Step 5: Register the worker and commit**

Register the repeatable job wherever `experiment-scheduler` is registered.

```bash
nice -n 19 npx tsc --noEmit -p apps/api
git add apps/api/src/workers/leaderboard-scheduler.ts \
        apps/api/src/workers/leaderboard-scheduler.test.ts apps/api/src/lib/metrics.ts
git commit -m "feat(leaderboards): season scheduler with snapshot-then-claim ordering

ClickHouse is queried before the season is claimed, so an outage leaves
the season ACTIVE with nothing written instead of closed and empty."
```

---

### Task 5: Dashboard API

**Files:**
- Modify: `apps/api/src/routes/dashboard/leaderboards.ts`
- Create: `apps/api/src/routes/dashboard/leaderboards.seasons.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces these routes, all under
  `/dashboard/projects/:projectId/leaderboards`:
  - `GET /` · `POST /` · `GET /:id` · `PATCH /:id` · `DELETE /:id`
  - `GET /:id/seasons`
  - `GET /seasons/:seasonId/standings`
  - `GET /:id/current`
- Writes require the existing `leaderboards:write` capability via
  `assertProjectCapability`; reads keep the current
  `MemberRole.CUSTOMER_SUPPORT` floor via `assertProjectAccess`.

- [ ] **Step 1: Write the failing test**

Cover at minimum:

```ts
test("rejects a CUSTOM cadence without customPeriodDays", async () => {
  // 400 -- validateCadence is enforced server-side, and the CHECK
  // constraint is the backstop, not the primary defence.
});

test("rejects customPeriodDays on a WEEKLY leaderboard", async () => {
  // 400.
});

test("rejects an unknown IANA timezone", async () => {
  // A bad zone would make every boundary computation throw inside the
  // worker, where it is far harder to diagnose than at the write.
});

test("GET /:id/current returns live standings for the ACTIVE season", async () => {
  // Assert the response window matches the active season's
  // [startsAt, endsAt), not an arbitrary caller-supplied range.
});

test("GET /:id/current on a leaderboard with no ACTIVE season returns an empty envelope", async () => {
  // Not a 404 -- a leaderboard whose first season has not opened yet is
  // a valid state, and the dashboard renders an empty state for it.
});

test("GET /seasons/:seasonId/standings returns the frozen snapshot", async () => {
  // Assert it reads Postgres, not ClickHouse: seed standings rows and
  // assert they come back even with no matching analytics data.
});

test("a project member cannot read another project's leaderboard", async () => {
  // 403/404 -- project scoping on every route, including the
  // seasons/standings ones that are keyed by season id rather than
  // project id.
});
```

Note the last one specifically: `GET /seasons/:seasonId/standings` is keyed by
season id, so it must resolve the season's leaderboard and check *that*
project, not trust the path's `:projectId`.

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/routes/dashboard/leaderboards.seasons.test.ts --maxWorkers=2
```

Expected: FAIL — routes do not exist.

- [ ] **Step 3: Implement the routes**

Follow the existing file's structure — `requireDashboardAuth`,
`assertProjectAccess` / `assertProjectCapability`, `ok()` envelopes, Zod
validation with the same error mapping. Reuse `queryStandings` for `/current`;
never inline the SQL a second time.

- [ ] **Step 4: Run it to verify it passes, then commit**

```bash
nice -n 19 npx vitest run apps/api/src/routes/dashboard/leaderboards --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/api
```

```bash
git add apps/api/src/routes/dashboard/leaderboards.ts apps/api/src/routes/dashboard/leaderboards.seasons.test.ts
git commit -m "feat(leaderboards): season CRUD, standings and current-season API"
```

---

### Task 6: Concurrency and end-to-end integration tests

**Files:**
- Create: `apps/api/src/workers/leaderboard-scheduler.integration.test.ts`

**Interfaces:** consumes everything above; produces nothing.

The unit tests use mocks, so they prove the sweep's *logic*. They cannot prove
the partial unique index exists or that the transaction actually rolls back.
Only a real database can, and those are precisely the properties this design
leans on.

- [ ] **Step 1: Write the test**

```ts
describe("leaderboard scheduler against a real database", () => {
  test("two concurrent sweeps open exactly one season", async () => {
    // Seed an enabled leaderboard with no season. Run two sweeps with
    // Promise.all. Assert exactly one ACTIVE season row exists.
    // This is the partial unique index doing its job -- assert it against
    // the database, because the constraint IS the design.
  });

  test("two concurrent sweeps close a due season exactly once", async () => {
    // Seed an ACTIVE season past its boundary + settle delay. Run two
    // sweeps concurrently. Assert one CLOSED season, one set of
    // standings (no duplicate ranks), and exactly one new ACTIVE season.
  });

  test("standings freeze the in-window events only", async () => {
    // Seed revenue events on both sides of the boundary in ClickHouse.
    // Run the sweep. Assert the frozen standings reflect only events
    // inside [startsAt, endsAt) -- this is what proves the settle delay
    // shifts WHEN the snapshot runs, never WHICH events it includes.
  });

  test("a ClickHouse failure mid-close leaves the season ACTIVE with no standings", async () => {
    // Point the ClickHouse client at a dead address for one sweep.
    // Assert: season still ACTIVE, zero standings rows, and a following
    // healthy sweep closes it correctly.
  });
});
```

Fill in each comment with real code.

**Test harness — read this before writing the file.** This repo has **no
per-file testcontainers bootstrap and no `withTestDb`/`seedProject` helper**.
`apps/api/tests/setup.ts` points the suite at the ambient docker-compose dev
stack (Postgres host 5433, Redis 6380, Redpanda 19092, ClickHouse 8124) and
tests seed inline with `getDb()` plus direct Drizzle inserts. Follow
`apps/api/src/workers/access-reconciliation.integration.test.ts`, which states
this convention explicitly and is the closest model.

Two consequences:
- Bring the stack up first (`docker compose up -d`). "Docker running" is not
  the same as "the stack is up".
- Seed fixtures with direct SQL/inserts, never by calling the code under test.
  A test that builds its baseline through the same writer it is checking
  asserts only that the writer agrees with itself.

If the ClickHouse assertions need an isolated instance rather than the
ambient one, this file starts a container and then:

**This file starts its own container, so it must be registered in two
places** or it will run at full worker concurrency and die intermittently
with `(HTTP code 409) container stopped/paused`:
1. Add its path to `CONTAINER_SUITES` in `apps/api/vitest.config.ts` — that
   second pass runs with concurrency turned down.
2. Pin its host port and register that pin in
   `apps/api/tests/host-port-allocations.test.ts`, which keeps the pins
   unique. The port must be known before the container starts, because a
   Kafka client connects on the address the broker advertises.

ClickHouse gotchas that have cost time before: write `AS e FINAL`, never
`FINAL AS e` (the latter is invalid), and mutate `env` in place rather than
reassigning `process.env` — the ClickHouse client reads a frozen env, so a
post-import reassignment has no effect. Give the file its own queue-name
suffix.

- [ ] **Step 2: Run it**

```bash
docker ps   # vitest hangs silently when Docker is down
nice -n 19 npx vitest run apps/api/src/workers/leaderboard-scheduler.integration.test.ts --maxWorkers=2
```

Expected: PASS. Drop `rovenue_test_tpl` first if the new migrations make the
cached template database stale.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/workers/leaderboard-scheduler.integration.test.ts
git commit -m "test(leaderboards): concurrency and window correctness on real infra"
```

---

### Task 7: Dashboard UI

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/leaderboards.tsx`
- Create: `apps/dashboard/src/components/leaderboards/leaderboard-form.tsx`
- Create: `apps/dashboard/src/components/leaderboards/season-selector.tsx`
- Modify: the dashboard i18n catalogue
- Modify/create: `apps/dashboard/tests/routes/leaderboards.test.tsx`

**Interfaces:** consumes the Task 5 API. Produces no server-side exports.

- [ ] **Step 1: Write the failing test**

```tsx
test("renders configured leaderboards alongside the ad-hoc range view", async () => {
  // The existing view must survive -- it is an explicit non-goal to
  // change or remove it.
});

test("shows an empty state when a leaderboard's first season has not closed", async () => {
  // Not an error state.
});

test("switching to a past season fetches the frozen standings", async () => {
  // Assert the request goes to /seasons/:id/standings, not /current.
});

test("customPeriodDays is only shown for the CUSTOM cadence", async () => {
  // And the form blocks submit when CUSTOM has no value.
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/dashboard/tests/routes/leaderboards.test.tsx --maxWorkers=2
```

- [ ] **Step 3: Implement**

Add the leaderboard list, the create/edit form and the season selector. Every
string is a `t()` key. Look up cadence and metric labels through explicit
maps:

```ts
const CADENCE_LABEL_KEYS: Record<LeaderboardCadence, string> = {
  WEEKLY: "leaderboards.cadence.weekly",
  MONTHLY: "leaderboards.cadence.monthly",
  CUSTOM: "leaderboards.cadence.custom",
};

const METRIC_LABEL_KEYS: Record<LeaderboardMetric, string> = {
  TOP_SPENDERS: "leaderboards.metric.topSpenders",
  TOP_CONSUMERS: "leaderboards.metric.topConsumers",
};
```

Never `t(\`leaderboards.cadence.${cadence.toLowerCase()}\`)` — a runtime-built
key is invisible to the extractor and ships as a missing translation.

- [ ] **Step 4: Run it, build, commit**

```bash
nice -n 19 npx vitest run apps/dashboard/tests/routes/leaderboards.test.tsx --maxWorkers=2
nice -n 19 npx tsc --noEmit -p apps/dashboard
pnpm build --concurrency=2
```

```bash
git add apps/dashboard/src apps/dashboard/tests
git commit -m "feat(dashboard): leaderboard config, seasons and standings UI"
```

- [ ] **Step 5: Tick the ROADMAP checkbox**

Mark "Leaderboards: season/reset automation" done in `ROADMAP.md` §12 with a
one-line note pointing at the scheduler. Commit.
