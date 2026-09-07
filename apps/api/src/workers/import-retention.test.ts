import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================
//
// `runImportRetention` calls `drizzle.<repo>.*` directly (no injected
// deps, unlike retention-sweep.ts's RetentionDeps) — mocked wholesale
// rather than spied on the real client, matching the pattern the
// now-deleted apps/api/tests/webhook-retention.test.ts used, so this
// file never needs a live database connection.
//
// `resolveProjectPolicyWindowDays` and `findRetentionPolicy` are NOT
// mocked — these tests exercise the real registry entry and the real
// window-resolution rules, so a change to either would actually be
// caught here rather than by a stub agreeing with itself.

import type { drizzle as RealDrizzle } from "@rovenue/db";

type ProjectWithTier = Awaited<
  ReturnType<typeof RealDrizzle.billingSubscriptionRepo.listProjectsWithTier>
>[number];
type RetentionEligibleImportJob = Awaited<
  ReturnType<
    typeof RealDrizzle.importJobRepo.listImportJobsEligibleForFileRetention
  >
>[number];

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    billingSubscriptionRepo: {
      listProjectsWithTier: vi.fn<(db: unknown) => Promise<ProjectWithTier[]>>(),
    },
    billingTierLimitsRepo: {
      findByTierAndCycle: vi.fn<
        (db: unknown, tier: string, cycle: string) => Promise<unknown>
      >(),
    },
    retentionOverrideRepo: {
      listRetentionOverrides: vi.fn<
        (db: unknown, projectId: string) => Promise<Map<string, number>>
      >(async () => new Map<string, number>()),
    },
    importJobRepo: {
      listImportJobsEligibleForFileRetention: vi.fn<
        (db: unknown, cutoff: Date) => Promise<RetentionEligibleImportJob[]>
      >(async () => []),
      markImportJobFilesDeleted: vi.fn<
        (db: unknown, id: string, deletedAt: Date) => Promise<void>
      >(async () => {}),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));

const deleteObjectMock = vi.fn<(key: string) => Promise<void>>(async () => {});
vi.mock("../lib/import-store", () => ({
  deleteObject: (key: string) => deleteObjectMock(key),
  buildReportPartStorageKey: (projectId: string, jobId: string, part: number) =>
    `imports/${projectId}/${jobId}/report-part-${part}`,
}));

import { runImportRetention } from "./import-retention";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function project(overrides: {
  projectId: string;
  tier?: ProjectWithTier["tier"];
  cycle?: ProjectWithTier["cycle"];
}): ProjectWithTier {
  return {
    projectId: overrides.projectId,
    tier: overrides.tier ?? null,
    cycle: overrides.cycle ?? null,
  };
}

function job(overrides: {
  id: string;
  projectId: string;
  finishedAt: Date | null;
  reportStorageKey?: string | null;
  reportPartCount?: number;
}) {
  return {
    id: overrides.id,
    projectId: overrides.projectId,
    storageKey: `imports/${overrides.projectId}/${overrides.id}/source`,
    reportStorageKey: overrides.reportStorageKey ?? null,
    reportPartCount: overrides.reportPartCount ?? 0,
    finishedAt: overrides.finishedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.retentionOverrideRepo.listRetentionOverrides.mockResolvedValue(
    new Map(),
  );
  drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention.mockResolvedValue(
    [],
  );
});

describe("runImportRetention", () => {
  it("still sweeps a no-tier, no-override project at the 7-day default the bespoke worker applied to everyone", async () => {
    // CORRECTED 2026-09-07. This test used to assert that such a project
    // was SKIPPED. That was the regression, not the contract: billing is
    // cloud-only, so "no tier and no override" is every self-hosted
    // deployment, and skipping them silently ended import-file retention
    // for the whole fleet while the worker still reported clean runs.
    // `import_jobs` now carries `defaultDays: IMPORT_FILE_RETENTION_DAYS`,
    // preserving exactly what `workers/import-retention.ts` did for every
    // project before commit `fa1d10ca` retired the bespoke workers.
    drizzleMock.billingSubscriptionRepo.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "proj_self_hosted" }),
    ]);

    const result = await runImportRetention(NOW);

    expect(result.projectsSkipped).toBe(0);
    expect(
      drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention,
    ).toHaveBeenCalled();
  });

  it("resolves a no-tier project's window from its override, floored at IMPORT_FILE_RETENTION_DAYS (7)", async () => {
    // No tier to clamp down to, so only the floor applies — an override
    // of 3 still resolves to 7 (Rule 2 of resolveProjectPolicyWindowDays).
    drizzleMock.billingSubscriptionRepo.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "proj_override" }),
    ]);
    drizzleMock.retentionOverrideRepo.listRetentionOverrides.mockResolvedValue(
      new Map([["import_jobs", 3]]),
    );
    drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention.mockResolvedValue(
      [job({ id: "job_old", projectId: "proj_override", finishedAt: daysAgo(10) })],
    );

    const result = await runImportRetention(NOW);

    expect(
      drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention,
    ).toHaveBeenCalledWith(drizzleMock.db, daysAgo(7));
    expect(result.deletedJobs).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_override/job_old/source",
    );
  });

  it("deletes a job's source file, report file and every report part, then marks filesDeletedAt", async () => {
    drizzleMock.billingSubscriptionRepo.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "proj_a" }),
    ]);
    drizzleMock.retentionOverrideRepo.listRetentionOverrides.mockResolvedValue(
      new Map([["import_jobs", 100]]), // no tier -> resolves to 100 (Rule 2, no ceiling)
    );
    drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention.mockResolvedValue(
      [
        job({
          id: "job_full",
          projectId: "proj_a",
          finishedAt: daysAgo(200),
          reportStorageKey: "imports/proj_a/job_full/report",
          reportPartCount: 2,
        }),
      ],
    );

    const result = await runImportRetention(NOW);

    expect(result.deletedJobs).toBe(1);
    expect(result.deletedFiles).toBe(4); // source + report + 2 parts
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_a/job_full/source",
    );
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_a/job_full/report",
    );
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_a/job_full/report-part-1",
    );
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_a/job_full/report-part-2",
    );
    expect(
      drizzleMock.importJobRepo.markImportJobFilesDeleted,
    ).toHaveBeenCalledWith(drizzleMock.db, "job_full", NOW);
  });

  it("re-checks each returned job against its OWN project's resolved window, not the loosest one used for the query", async () => {
    // proj_short resolves to 7 days (no tier, but an explicit override —
    // Rule 2); proj_long resolves to 365 (studio tier, no override —
    // Rule 1). The eligibility query is called with the LOOSEST cutoff
    // (7 days), so it can return a job from proj_long that is only 30
    // days old — that job must NOT be swept, because proj_long's own
    // window (365) has not elapsed for it.
    drizzleMock.billingSubscriptionRepo.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "proj_short" }),
      project({ projectId: "proj_long", tier: "studio", cycle: "monthly" }),
    ]);
    drizzleMock.retentionOverrideRepo.listRetentionOverrides.mockImplementation(
      async (_db: unknown, projectId: string) =>
        projectId === "proj_short"
          ? new Map([["import_jobs", 7]])
          : new Map(),
    );
    drizzleMock.billingTierLimitsRepo.findByTierAndCycle.mockResolvedValue({
      tier: "studio",
      cycle: "monthly",
      retentionDays: 365,
      auditLogDays: 365,
    });
    drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention.mockResolvedValue(
      [
        job({ id: "job_short_old", projectId: "proj_short", finishedAt: daysAgo(10) }),
        job({ id: "job_long_recent", projectId: "proj_long", finishedAt: daysAgo(30) }),
      ],
    );

    const result = await runImportRetention(NOW);

    expect(result.deletedJobs).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_short/job_short_old/source",
    );
    expect(deleteObjectMock).not.toHaveBeenCalledWith(
      "imports/proj_long/job_long_recent/source",
    );
    expect(
      drizzleMock.importJobRepo.markImportJobFilesDeleted,
    ).not.toHaveBeenCalledWith(drizzleMock.db, "job_long_recent", NOW);
  });

  it("leaves a returned job untouched when its own project's window is unresolved", async () => {
    // A job belonging to a project whose window could not be resolved must
    // not be swept just because SOME other project's window was used to
    // fetch the candidate set. That property is unchanged.
    //
    // The SCENARIO changed on 2026-09-07. It used to make proj_unresolved
    // tierless with no override, which no longer skips: `import_jobs` now
    // carries `defaultDays`, so a tierless project resolves to the 7-day
    // window the bespoke worker applied to everyone. The remaining way to
    // be genuinely unresolved is to HAVE a tier whose `billing_tier_limits`
    // row is missing — RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND, which
    // must never be read as "doesn't care".
    drizzleMock.billingSubscriptionRepo.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "proj_resolved" }),
      project({
        projectId: "proj_unresolved",
        tier: "studio",
        cycle: "monthly",
      }),
    ]);
    drizzleMock.billingTierLimitsRepo.findByTierAndCycle.mockResolvedValue(null);
    drizzleMock.retentionOverrideRepo.listRetentionOverrides.mockImplementation(
      async (_db: unknown, projectId: string) =>
        projectId === "proj_resolved"
          ? new Map([["import_jobs", 7]])
          : new Map(),
    );
    drizzleMock.importJobRepo.listImportJobsEligibleForFileRetention.mockResolvedValue(
      [
        job({ id: "job_resolved", projectId: "proj_resolved", finishedAt: daysAgo(30) }),
        job({ id: "job_unresolved", projectId: "proj_unresolved", finishedAt: daysAgo(30) }),
      ],
    );

    const result = await runImportRetention(NOW);

    expect(result.deletedJobs).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(
      "imports/proj_resolved/job_resolved/source",
    );
    expect(deleteObjectMock).not.toHaveBeenCalledWith(
      "imports/proj_unresolved/job_unresolved/source",
    );
  });
});
