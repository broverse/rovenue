import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "../../i18n/config";
import { DryRunSummary } from "./dry-run-summary";
import {
  ENRICHMENT_AUXILIARY_KEYS,
  IMPORT_ENRICHMENT_OUTCOME_ORDER,
} from "./constants";
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
    kind: "HISTORY",
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "abc",
    mapping: {},
    options: {},
    status: "DRY_RUN_COMPLETE",
    checkpointLine: 0,
    counters: {},
    dryRunSummary: null,
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
    // The recommended action must be one that actually works.
    //
    // Final-fix-wave FIX 9 asserted the OPPOSITE of the line below —
    // that the copy must NOT mention a second import — because at the
    // time the token file 400'd on every attempt (its three columns
    // could not satisfy the then-global required store/purchaseDate
    // fields, and nothing joined a token to an existing purchase). The
    // Google purchase-token second pass now exists, so recovering these
    // subscriptions no longer depends on the user's device ever opening
    // the app again, and the second import is the FIRST thing to
    // recommend. The SDK cut-over stays as the fallback for anyone the
    // token file misses.
    expect(warning).toHaveTextContent(/no live entitlement grant/i);
    expect(warning).toHaveTextContent(/second import/i);
    expect(warning).toHaveTextContent(/purchase-token file/i);
    expect(warning).toHaveTextContent(/restorePurchases/);
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

    // Final-fix-wave minor fix: the scope note must still render even
    // when every verify counter happens to be zero/absent (e.g. the cap
    // was hit before this call resolved anything) — it is not gated on
    // there being a non-empty bucket list underneath it.
    expect(screen.getByTestId("import-verification-scope-note")).toHaveTextContent(
      /not the whole file/i,
    );
  });

  // ===========================================================
  // Final-fix-wave minor fix — the scope note now sits directly above
  // the verification counters it describes, not above the unrelated
  // Phase-A row buckets
  // ===========================================================

  it("renders Phase B's own verification counters, with the scope note directly above them", () => {
    render(
      <DryRunSummary
        job={makeJob({
          status: "COMPLETED",
          counters: {
            willCreate: 500,
            verifyAnchorVerified: 480,
            verifyAnchorNotFound: 15,
            verifyAnchorPending: 0,
            verifyAnchorUnverifiable: 5,
          },
          verificationCountersScope: "wholeFile",
        })}
      />,
    );

    const section = screen.getByTestId("import-verification-counters");
    const scopeNote = screen.getByTestId("import-verification-scope-note");
    expect(section).toContainElement(scopeNote);

    expect(screen.getByTestId("import-verify-counter-verifyAnchorVerified")).toHaveTextContent(
      "480",
    );
    expect(screen.getByTestId("import-verify-counter-verifyAnchorNotFound")).toHaveTextContent(
      "15",
    );
    expect(
      screen.getByTestId("import-verify-counter-verifyAnchorUnverifiable"),
    ).toHaveTextContent("5");
    // Zero-count buckets are omitted, same convention as the Phase-A list.
    expect(
      screen.queryByTestId("import-verify-counter-verifyAnchorPending"),
    ).not.toBeInTheDocument();

    // The scope note precedes the verify buckets in document order, and
    // the Phase-A row buckets render in a SEPARATE list entirely — the
    // note no longer sits directly above a list it doesn't describe.
    const verifyList = section.querySelector("ul");
    expect(
      scopeNote.compareDocumentPosition(verifyList!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders nothing extra when Phase B has never touched this job", () => {
    render(
      <DryRunSummary
        job={makeJob({
          status: "DRY_RUN_COMPLETE",
          counters: { willCreate: 500 },
          verificationCountersScope: null,
        })}
      />,
    );

    expect(screen.queryByTestId("import-verification-counters")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-verification-scope-note")).not.toBeInTheDocument();
  });

  it("shows an empty state instead of a summary when nothing has been scanned yet", () => {
    render(<DryRunSummary job={makeJob({ counters: {} })} />);

    expect(screen.getByTestId("import-summary-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("import-dry-run-summary")).not.toBeInTheDocument();
  });
});

// =============================================================
// Final-fix-wave FIX 7 — the dry run's disclosures are no longer thrown
// away
// =============================================================
//
// observedEventDateRange/requiredPartitionSpan/entitlementShapeCounts/
// duplicateTrackingDisabledAfterKeys were computed by planImport but had
// zero consumers repo-wide before this fix. This is the UI-side half of
// closing that gap — the API side is `toDto` passing `dryRunSummary`
// through unchanged (routes/dashboard/imports.ts).

describe("DryRunSummary — disclosures (final-fix-wave FIX 7)", () => {
  it("renders the observed event-date range and required partition span BEFORE the outcome buckets", () => {
    render(
      <DryRunSummary
        job={makeJob({
          counters: { willCreate: 10 },
          dryRunSummary: {
            entitlementShapeCounts: {},
            duplicateTrackingDisabledAfterKeys: null,
            observedEventDateRange: {
              min: "2019-06-15T00:00:00.000Z",
              max: "2026-01-10T00:00:00.000Z",
            },
            requiredPartitionSpan: { fromMonth: "2019-06", toMonth: "2026-01", monthCount: 80 },
          },
        })}
      />,
    );

    const disclosures = screen.getByTestId("import-dry-run-disclosures");
    expect(screen.getByTestId("import-observed-event-date-range")).toHaveTextContent("2019");
    expect(screen.getByTestId("import-observed-event-date-range")).toHaveTextContent("2026");
    expect(screen.getByTestId("import-required-partition-span")).toHaveTextContent("2019-06");
    expect(screen.getByTestId("import-required-partition-span")).toHaveTextContent("2026-01");
    expect(screen.getByTestId("import-required-partition-span")).toHaveTextContent("80 months");

    // Disclosures precede the outcome bucket list in document order — the
    // operator must see them BEFORE reading the row-level breakdown.
    const summary = screen.getByTestId("import-dry-run-summary");
    const disclosurePos = Array.from(summary.children).indexOf(disclosures);
    const bucketListPos = Array.from(summary.children).findIndex((el) =>
      el.tagName === "UL",
    );
    expect(disclosurePos).toBeLessThan(bucketListPos);
  });

  it("renders observed entitlement identifier shapes", () => {
    render(
      <DryRunSummary
        job={makeJob({
          counters: { willCreate: 10 },
          dryRunSummary: {
            entitlementShapeCounts: { bracketed: 900, commaSeparated: 100 },
            duplicateTrackingDisabledAfterKeys: null,
            observedEventDateRange: null,
            requiredPartitionSpan: null,
          },
        })}
      />,
    );

    const shapes = screen.getByTestId("import-entitlement-shape-counts");
    expect(shapes).toHaveTextContent("bracketed (900)");
    expect(shapes).toHaveTextContent("commaSeparated (100)");
  });

  it("discloses when duplicate-in-file tracking was capped, and stays silent when it wasn't", () => {
    const { rerender } = render(
      <DryRunSummary
        job={makeJob({
          counters: { willCreate: 10 },
          dryRunSummary: {
            entitlementShapeCounts: {},
            duplicateTrackingDisabledAfterKeys: 2_000_000,
            observedEventDateRange: null,
            requiredPartitionSpan: null,
          },
        })}
      />,
    );
    expect(screen.getByTestId("import-duplicate-tracking-disclosure")).toHaveTextContent(
      "2,000,000",
    );

    rerender(
      <DryRunSummary
        job={makeJob({
          counters: { willCreate: 10 },
          dryRunSummary: {
            entitlementShapeCounts: {},
            duplicateTrackingDisabledAfterKeys: null,
            observedEventDateRange: null,
            requiredPartitionSpan: null,
          },
        })}
      />,
    );
    expect(screen.queryByTestId("import-duplicate-tracking-disclosure")).not.toBeInTheDocument();
  });

  it("renders nothing extra when the job has no dryRunSummary yet", () => {
    render(<DryRunSummary job={makeJob({ counters: { willCreate: 10 }, dryRunSummary: null })} />);

    expect(screen.queryByTestId("import-dry-run-disclosures")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-duplicate-tracking-disclosure")).not.toBeInTheDocument();
  });
});

// =============================================================
// GOOGLE_TOKEN_ENRICHMENT summaries
// =============================================================

describe("DryRunSummary — enrichment jobs", () => {
  /**
   * Builds the counters object the API ACTUALLY emits for an enrichment
   * job at DRY_RUN_COMPLETE, rather than only the keys a given assertion
   * cares about.
   *
   * That distinction is not pedantry — it is the bug this helper exists
   * because of. `toDto` reconstructs a pre-commit job's counters from the
   * kind's key list, so the object the client receives always carries
   * EVERY key of that kind at zero, never a sparse subset. The first
   * version of these tests hand-built `{ungroupedChains: 4,
   * ungroupedChainsPurchaseRows: 11}` — a shape the route could not
   * produce at that status at all, because the two auxiliary keys were
   * being dropped by exactly that reconstruction. The component tests
   * passed while the real callout rendered "enrich 0 more purchase
   * row(s)".
   *
   * Mirrors `readDryRunCounters(kind, …)` in
   * apps/api/src/services/import/report.ts.
   */
  function dtoCounters(present: Record<string, number>): Record<string, number> {
    const keys = [...IMPORT_ENRICHMENT_OUTCOME_ORDER, ...ENRICHMENT_AUXILIARY_KEYS];
    return Object.fromEntries(keys.map((key) => [key, present[key] ?? 0]));
  }

  function enrichmentJob(counters: Record<string, number>): ImportJob {
    return makeJob({
      kind: "GOOGLE_TOKEN_ENRICHMENT",
      status: "DRY_RUN_COMPLETE",
      counters: dtoCounters(counters),
    });
  }

  it("renders the enrichment buckets under their own labels", () => {
    render(
      <DryRunSummary job={enrichmentJob({ enriched: 12, alreadyEnriched: 3, noMatch: 1 })} />,
    );

    const enriched = screen.getByTestId("import-outcome-enriched");
    expect(enriched).toHaveTextContent("Token applied");
    expect(enriched).toHaveTextContent("12");
    expect(screen.getByTestId("import-outcome-alreadyEnriched")).toHaveTextContent(
      "Already had this token",
    );
    expect(screen.getByTestId("import-outcome-noMatch")).toBeInTheDocument();
  });

  it("names enrichUngroupedChains whenever that bucket is non-zero", () => {
    // The whole point: an operator whose file lands here has no other
    // way to learn the option exists. The purchase-row count is what
    // makes it an offer rather than a complaint, so it is asserted as a
    // distinct number from the bucket count — "11" cannot be satisfied
    // by the "4" above it.
    render(
      <DryRunSummary
        job={enrichmentJob({ ungroupedChains: 4, ungroupedChainsPurchaseRows: 11 })}
      />,
    );

    const warning = screen.getByTestId("import-ungrouped-chains-warning");
    expect(warning).toHaveTextContent(/link unlinked renewals/i);
    expect(warning).toHaveTextContent("4 subscribers");
    expect(warning).toHaveTextContent("enrich 11 more purchase row");
  });

  it("shows the purchase-row count alongside the applied-token bucket", () => {
    render(
      <DryRunSummary job={enrichmentJob({ enriched: 4, enrichedPurchaseRows: 9 })} />,
    );

    expect(screen.getByTestId("import-enriched-purchase-rows")).toHaveTextContent(
      "9 purchase row",
    );
  });

  it("does not show that warning when nothing landed in the bucket", () => {
    render(<DryRunSummary job={enrichmentJob({ enriched: 2 })} />);

    expect(screen.queryByTestId("import-ungrouped-chains-warning")).toBeNull();
  });

  it("never shows the android-no-token advice on an enrichment job", () => {
    // That message tells the operator to request a token file and run a
    // second import — which is exactly the job they are already looking
    // at.
    render(<DryRunSummary job={enrichmentJob({ enriched: 1, androidNoToken: 9 })} />);

    expect(screen.queryByTestId("import-android-no-token-warning")).toBeNull();
  });
});
