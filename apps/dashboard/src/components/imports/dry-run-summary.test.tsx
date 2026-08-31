import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "../../i18n/config";
import { DryRunSummary } from "./dry-run-summary";
import type { ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Task 11 — dry-run summary
// =============================================================
//
// Two things this file pins, straight from the task brief and its
// controller context:
//
// 1. Every NON-ZERO outcome bucket renders with its count; a bucket at
//    zero is omitted rather than shown as "0 rows".
// 2. The Android warning renders WITH ITS COUNT (not as a bare boolean)
//    whenever `androidNoToken > 0` — task-11 controller context honesty
//    item 3 is explicit that "some rows may lack tokens" is not
//    actionable, "1,284 subscriptions…" is.

const PROJECT_ID = "p_1";

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job_1",
    projectId: PROJECT_ID,
    createdByUserId: "u_1",
    sourceLabel: "RevenueCat export",
    presetId: "revenuecat-transactions",
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "abc",
    mapping: {},
    options: {},
    status: "DRY_RUN_COMPLETE",
    checkpointLine: 0,
    counters: {},
    reportStorageKey: "imports/p_1/job_1/dry-run-report.ndjson",
    reportPartCount: 0,
    errorMessage: null,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: "2026-08-31T00:05:00.000Z",
    filesDeletedAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:05:00.000Z",
    verificationCountersScope: null,
    ...overrides,
  };
}

describe("DryRunSummary", () => {
  it("renders each non-zero outcome bucket with its count, and omits zero buckets", () => {
    render(
      <DryRunSummary
        job={makeJob({
          counters: {
            willCreate: 4200,
            willUpdate: 0,
            skippedSandbox: 12,
            unresolvedProduct: 3,
            anchorless: 0,
            androidNoToken: 0,
            invalidRow: 1,
            duplicateInFile: 0,
          },
        })}
      />,
    );

    expect(screen.getByTestId("import-outcome-willCreate")).toHaveTextContent("4,200");
    expect(screen.getByTestId("import-outcome-skippedSandbox")).toHaveTextContent("12");
    expect(screen.getByTestId("import-outcome-unresolvedProduct")).toHaveTextContent("3");
    expect(screen.getByTestId("import-outcome-invalidRow")).toHaveTextContent("1");

    expect(screen.queryByTestId("import-outcome-willUpdate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-outcome-anchorless")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-outcome-androidNoToken")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-outcome-duplicateInFile")).not.toBeInTheDocument();

    expect(screen.queryByTestId("import-android-no-token-warning")).not.toBeInTheDocument();
  });

  it("renders the Android warning with its count when androidNoToken > 0", () => {
    render(
      <DryRunSummary
        job={makeJob({
          counters: { willCreate: 10, androidNoToken: 1284 },
        })}
      />,
    );

    const warning = screen.getByTestId("import-android-no-token-warning");
    expect(warning).toHaveTextContent("1,284");
    expect(warning).toHaveTextContent(/android/i);
    expect(warning).toHaveTextContent(/will not grant live access/i);
    // Actionable, not just a fact — the operator's actual next step.
    expect(warning).toHaveTextContent(/revenuecat support/i);
  });

  it("labels the counters as an inspected subset, not a whole-file total, when the anchor cap was hit", () => {
    render(
      <DryRunSummary
        job={makeJob({
          status: "VERIFICATION_INCOMPLETE",
          counters: { willCreate: 500 },
          verificationCountersScope: "inspectedSubset",
        })}
      />,
    );

    expect(screen.getByTestId("import-verification-scope-note")).toHaveTextContent(
      /not the whole file/i,
    );
  });

  it("shows an empty state instead of a summary when nothing has been scanned yet", () => {
    render(<DryRunSummary job={makeJob({ counters: {} })} />);

    expect(screen.getByTestId("import-summary-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("import-dry-run-summary")).not.toBeInTheDocument();
  });
});
