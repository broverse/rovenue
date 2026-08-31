import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import "../../i18n/config";
import { server } from "../../../tests/msw/server";
import { MappingEditor } from "./mapping-editor";
import type { ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Task 11 — mapping editor
// =============================================================
//
// Two things this file pins:
//
// 1. (task-11 brief) An unmapped REQUIRED field blocks the primary "save
//    mapping" action and names the missing field by its human label —
//    not a generic "invalid mapping" message. `validateMapping`
//    (@rovenue/shared) is the same function the server's PATCH route
//    runs, so this is testing the exact gate the server would apply,
//    reused client-side.
// 2. (task-11 fix round 1) When `GET .../imports/:id/columns` returns a
//    real header, each field becomes a PICKER over those columns and
//    shows which are still unassigned; when that request fails (or
//    finds nothing), the editor degrades to the original free-text
//    input rather than breaking.

const PROJECT_ID = "p_1";
const BASE = "http://localhost:3000";
const columnsUrl = `${BASE}/dashboard/projects/${PROJECT_ID}/imports/job_1/columns`;

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

// Every editable-mapping test triggers a `GET .../columns` peek on mount
// (`useImportColumns`). Default to "nothing found" so the pre-existing
// free-text-based assertions below keep exercising exactly the fallback
// path they always have; tests that care about the picker override this
// with `server.use(...)`.
beforeEach(() => {
  server.use(
    http.get(columnsUrl, () => HttpResponse.json({ data: { columns: [] } })),
  );
});

describe("MappingEditor — required-field gate", () => {
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

describe("MappingEditor — source-column picker (fix round 1)", () => {
  it("renders the fetched columns as choices and shows which are still unassigned", async () => {
    server.use(
      http.get(columnsUrl, () =>
        HttpResponse.json({
          data: { columns: ["app_user_id", "store", "product_id", "purchase_date", "country"] },
        }),
      ),
    );

    wrap(
      <MappingEditor
        projectId={PROJECT_ID}
        job={makeJob({
          mapping: { app_user_id: "subscriberExternalId", store: "store" },
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/^source column for store$/i).tagName).toBe("SELECT"),
    );
    const storeField = screen.getByLabelText(/^source column for store$/i) as HTMLSelectElement;
    expect(within(storeField).getByRole("option", { name: "product_id" })).toBeInTheDocument();

    // Already-assigned columns (app_user_id, store) are not "unassigned";
    // the rest of the fetched header is.
    const unassigned = screen.getByTestId("import-unassigned-columns");
    expect(unassigned).toHaveTextContent("product_id");
    expect(unassigned).toHaveTextContent("purchase_date");
    expect(unassigned).toHaveTextContent("country");
    expect(unassigned).not.toHaveTextContent("app_user_id,");
  });

  it("lets picking a column satisfy the required-field gate", async () => {
    server.use(
      http.get(columnsUrl, () =>
        HttpResponse.json({
          data: { columns: ["app_user_id", "store", "product_id", "purchase_date"] },
        }),
      ),
    );

    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: {} })} />);

    const subscriberField = await screen.findByLabelText(/source column for subscriber id/i);
    fireEvent.change(subscriberField, { target: { value: "app_user_id" } });
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
  });

  it("still works — free text, no picker — when the columns request fails", async () => {
    server.use(http.get(columnsUrl, () => HttpResponse.error()));

    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: {} })} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-columns-fallback-note")).toHaveTextContent(
        /couldn't read this file's column names/i,
      ),
    );

    const storeField = screen.getByLabelText(/^source column for store$/i);
    expect(storeField.tagName).toBe("INPUT");
    fireEvent.change(storeField, { target: { value: "store" } });
    expect(storeField).toHaveValue("store");
    expect(screen.queryByTestId("import-unassigned-columns")).not.toBeInTheDocument();
  });

  it("does not peek columns at all once the mapping is no longer editable", async () => {
    // A non-empty column list registered here would flip the field to a
    // SELECT if `useImportColumns`'s `enabled` gate were ever wired
    // wrong — waiting past a tick and asserting it's STILL an INPUT
    // proves the request never happened, not just that it hasn't
    // resolved yet.
    server.use(
      http.get(columnsUrl, () => HttpResponse.json({ data: { columns: ["store"] } })),
    );

    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ status: "RUNNING" })} />);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByTestId("import-columns-fallback-note")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^source column for store$/i).tagName).toBe("INPUT");
  });
});
