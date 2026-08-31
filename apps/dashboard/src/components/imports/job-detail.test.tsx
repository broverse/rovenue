import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import "../../i18n/config";
import { server } from "../../../tests/msw/server";
import { ImportJobDetail } from "./job-detail";
import type { ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Task 11 — job detail: polling + report link
// =============================================================
//
// Two things this file pins, straight from the task brief:
//
// 1. Polling STOPS on a terminal status. Asserted both ways: the job
//    reaches COMPLETED after several polls, AND the request count does
//    not move for a further stretch of real time afterwards — a test
//    that only checks polling starts proves nothing (task-11 brief).
//    `IMPORT_POLL_INTERVAL_MS` is mocked down to 20ms for this file only
//    so the test doesn't spend 5+ real seconds per assertion.
// 2. The report download link renders ONLY once the job DTO says a
//    report exists (`reportStorageKey` or `reportPartCount > 0`), never
//    speculatively.

vi.mock("./constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constants")>();
  return { ...actual, IMPORT_POLL_INTERVAL_MS: 20 };
});

const PROJECT_ID = "p_1";
const JOB_ID = "job_1";
const BASE = "http://localhost:3000";
const jobUrl = `${BASE}/dashboard/projects/${PROJECT_ID}/imports/${JOB_ID}`;

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    createdByUserId: "u_1",
    sourceLabel: "RevenueCat export",
    presetId: null,
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "abc",
    mapping: { app_user_id: "subscriberExternalId" },
    options: {},
    status: "RUNNING",
    checkpointLine: 0,
    counters: {},
    reportStorageKey: null,
    reportPartCount: 0,
    errorMessage: null,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    filesDeletedAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    verificationCountersScope: null,
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// `DRY_RUN_COMPLETE` renders the mapping editor, which peeks
// `GET .../columns` on mount (task-11 fix round 1) — none of the tests
// below care about that response, so a blanket empty-list default keeps
// them focused on polling/report-link behaviour instead of every test
// having to know about a request it isn't testing.
beforeEach(() => {
  server.use(
    http.get(`${jobUrl}/columns`, () => HttpResponse.json({ data: { columns: [] } })),
  );
});

describe("ImportJobDetail polling", () => {
  it("polls while RUNNING and stops once the job reaches a terminal status", async () => {
    let callCount = 0;
    server.use(
      http.get(jobUrl, () => {
        callCount += 1;
        const status = callCount < 3 ? "RUNNING" : "COMPLETED";
        return HttpResponse.json({
          data: { job: makeJob({ status, counters: status === "COMPLETED" ? { willCreate: 5 } : {} }) },
        });
      }),
    );

    wrap(<ImportJobDetail projectId={PROJECT_ID} jobId={JOB_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-job-detail")).toHaveAttribute(
        "data-job-status",
        "COMPLETED",
      ),
    );
    const countAtCompletion = callCount;
    expect(countAtCompletion).toBeGreaterThanOrEqual(3);

    // Give the (now-fast) poll interval several more chances to fire.
    // The count must not move — this is the "assert it stops" half the
    // brief calls out by name.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callCount).toBe(countAtCompletion);
  });
});

describe("ImportJobDetail report link", () => {
  it("does not render a report link when no report exists yet", async () => {
    server.use(
      http.get(jobUrl, () =>
        HttpResponse.json({
          data: { job: makeJob({ status: "RUNNING", reportStorageKey: null, reportPartCount: 0 }) },
        }),
      ),
    );

    wrap(<ImportJobDetail projectId={PROJECT_ID} jobId={JOB_ID} />);

    await screen.findByTestId("import-job-detail");
    expect(screen.queryByTestId("import-report-download-link")).not.toBeInTheDocument();
  });

  it("renders the report link once the job has commit report parts", async () => {
    server.use(
      http.get(jobUrl, () =>
        HttpResponse.json({
          data: {
            job: makeJob({ status: "COMPLETED", reportPartCount: 2, counters: { willCreate: 5 } }),
          },
        }),
      ),
    );

    wrap(<ImportJobDetail projectId={PROJECT_ID} jobId={JOB_ID} />);

    const link = await screen.findByTestId("import-report-download-link");
    expect(link).toHaveAttribute("href", expect.stringContaining(`/imports/${JOB_ID}/report`));
  });

  it("renders the report link from a dry-run's own report key even before any commit", async () => {
    server.use(
      http.get(jobUrl, () =>
        HttpResponse.json({
          data: {
            job: makeJob({
              status: "DRY_RUN_COMPLETE",
              reportStorageKey: "imports/p_1/job_1/dry-run-report.ndjson",
              reportPartCount: 0,
              counters: { willCreate: 5 },
            }),
          },
        }),
      ),
    );

    wrap(<ImportJobDetail projectId={PROJECT_ID} jobId={JOB_ID} />);

    await screen.findByTestId("import-report-download-link");
  });
});
