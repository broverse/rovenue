import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "../../i18n/config";
import { JobStatusBanner } from "./status-banner";
import type { ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Task 11 — job status banner
// =============================================================
//
// Task-11 controller context, honesty item 1: VERIFICATION_INCOMPLETE
// and VERIFYING are both normal, resumable resting states — never
// failures. This file pins that they render with the resume affordance
// and WITHOUT the failure-only `role="alert"` / danger styling FAILED
// gets.

const PROJECT_ID = "p_1";

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job_1",
    projectId: PROJECT_ID,
    createdByUserId: "u_1",
    sourceLabel: "RevenueCat export",
    presetId: null,
    kind: "HISTORY",
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "abc",
    mapping: {},
    options: {},
    status: "RUNNING",
    checkpointLine: 0,
    counters: {},
    dryRunSummary: null,
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

describe("JobStatusBanner", () => {
  it("VERIFICATION_INCOMPLETE renders a resume affordance and is NOT styled as a failure", () => {
    render(
      <JobStatusBanner
        job={makeJob({ status: "VERIFICATION_INCOMPLETE" })}
        onResume={vi.fn()}
        resuming={false}
      />,
    );

    const banner = screen.getByTestId("import-status-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner.className).not.toMatch(/rv-danger/);
    expect(screen.getByRole("button", { name: /resume/i })).toBeEnabled();
  });

  it("VERIFYING also renders the resume affordance without failure styling", () => {
    render(
      <JobStatusBanner job={makeJob({ status: "VERIFYING" })} onResume={vi.fn()} resuming={false} />,
    );

    const banner = screen.getByTestId("import-status-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner.className).not.toMatch(/rv-danger/);
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("FAILED is styled as a failure and does NOT show a resume button", () => {
    render(
      <JobStatusBanner
        job={makeJob({ status: "FAILED", errorMessage: "Storage unreachable" })}
        onResume={vi.fn()}
        resuming={false}
      />,
    );

    const banner = screen.getByTestId("import-status-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner.className).toMatch(/rv-danger/);
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
    expect(banner).toHaveTextContent("Storage unreachable");
  });

  it("RUNNING renders as an in-progress status, not a failure, with no resume button", () => {
    render(
      <JobStatusBanner job={makeJob({ status: "RUNNING" })} onResume={vi.fn()} resuming={false} />,
    );

    const banner = screen.getByTestId("import-status-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
  });
});
