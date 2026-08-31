import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../i18n/config";
import { MappingEditor } from "./mapping-editor";
import type { ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Task 11 — mapping editor
// =============================================================
//
// The one thing this file pins, straight from the task brief: an
// unmapped REQUIRED field blocks the primary "save mapping" action and
// names the missing field by its human label — not a generic "invalid
// mapping" message. `validateMapping` (@rovenue/shared) is the same
// function the server's PATCH route runs, so this is testing the exact
// gate the server would apply, reused client-side.

const PROJECT_ID = "p_1";

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job_1",
    projectId: PROJECT_ID,
    createdByUserId: "u_1",
    sourceLabel: "RevenueCat export",
    presetId: null,
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "abc",
    mapping: {},
    options: {},
    status: "PENDING_MAPPING",
    checkpointLine: 0,
    counters: {},
    reportStorageKey: null,
    reportPartCount: 0,
    errorMessage: null,
    startedAt: null,
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

describe("MappingEditor", () => {
  it("blocks the save action and names the missing required field when nothing is mapped", () => {
    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: {} })} />);

    const saveButton = screen.getByRole("button", { name: /save mapping/i });
    expect(saveButton).toBeDisabled();

    const missingMessage = screen.getByRole("alert");
    expect(missingMessage).toHaveTextContent(/subscriber id/i);
    expect(missingMessage).toHaveTextContent(/store/i);
    expect(missingMessage).toHaveTextContent(/product identifier/i);
    expect(missingMessage).toHaveTextContent(/purchase date/i);
  });

  it("still blocks and names the single remaining field when only one required field is unmapped", () => {
    wrap(
      <MappingEditor
        projectId={PROJECT_ID}
        job={makeJob({
          mapping: {
            app_user_id: "subscriberExternalId",
            store: "store",
            product_id: "productIdentifier",
            // purchaseDate deliberately left unmapped
          },
        })}
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save mapping/i });
    expect(saveButton).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/purchase date/i);
  });

  it("enables the save action once every required field is mapped", () => {
    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: {} })} />);

    fireEvent.change(screen.getByLabelText(/source column for subscriber id/i), {
      target: { value: "app_user_id" },
    });
    fireEvent.change(screen.getByLabelText(/^source column for store$/i), {
      target: { value: "store" },
    });
    fireEvent.change(screen.getByLabelText(/source column for product identifier/i), {
      target: { value: "product_id" },
    });
    fireEvent.change(screen.getByLabelText(/source column for purchase date/i), {
      target: { value: "purchase_date" },
    });

    expect(screen.getByRole("button", { name: /save mapping/i })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables editing once the mapping is no longer editable (e.g. a run is already in progress)", () => {
    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ status: "RUNNING" })} />);

    expect(screen.getByLabelText(/^source column for store$/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save mapping/i })).toBeDisabled();
  });
});
