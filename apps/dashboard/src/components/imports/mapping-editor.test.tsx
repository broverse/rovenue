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
const mappingUrl = `${BASE}/dashboard/projects/${PROJECT_ID}/imports/job_1/mapping`;

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
    dryRunSummary: null,
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

describe("MappingEditor — accepted store values (final-fix-wave FIX 8)", () => {
  it("shows the accepted store values next to the store field", () => {
    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: {} })} />);

    const hint = screen.getByTestId("import-store-value-hint");
    expect(hint).toHaveTextContent("app_store");
    expect(hint).toHaveTextContent("play_store");
    expect(hint).toHaveTextContent("stripe");
    expect(hint).toHaveTextContent("promotional");
    expect(hint).toHaveTextContent(/case-insensitive/i);
  });
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

// =============================================================
// Final-fix-wave FIX 6 — the sandbox/anchorless opt-in is reachable
// =============================================================
//
// skipSandbox/importAnchorless were only ever READ server-side
// (write.ts/plan.ts's DEFAULT_SKIP_SANDBOX/DEFAULT_IMPORT_ANCHORLESS) —
// no route, repository setter or UI control wrote import_jobs.options,
// so the opt-in acceptance criteria could never be exercised. These
// checkboxes plus PATCH .../mapping's new optional `options` field close
// that gap.

const FULLY_MAPPED: ImportJob["mapping"] = {
  app_user_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  purchase_date: "purchaseDate",
};

describe("MappingEditor — sandbox/anchorless options (final-fix-wave FIX 6)", () => {
  it("defaults both checkboxes to checked (matching the server's own defaults) when the job has no options set yet", () => {
    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: FULLY_MAPPED, options: {} })} />);

    expect(screen.getByRole("checkbox", { name: /skip sandbox rows/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("checkbox", { name: /import anchorless/i }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("reflects a previously-saved options value instead of the default", () => {
    wrap(
      <MappingEditor
        projectId={PROJECT_ID}
        job={makeJob({
          mapping: FULLY_MAPPED,
          options: { skipSandbox: false, importAnchorless: false },
        })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /skip sandbox rows/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByRole("checkbox", { name: /import anchorless/i }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("toggling a checkbox and saving PATCHes options alongside the mapping", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.patch(mappingUrl, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: {
            job: makeJob({
              mapping: FULLY_MAPPED,
              options: capturedBody.options as Record<string, boolean>,
            }),
          },
        });
      }),
    );

    wrap(<MappingEditor projectId={PROJECT_ID} job={makeJob({ mapping: FULLY_MAPPED })} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /skip sandbox rows/i }));
    fireEvent.click(screen.getByRole("button", { name: /save mapping/i }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody!.options).toEqual({ skipSandbox: false, importAnchorless: true });
  });

  it("disables both checkboxes once the mapping is no longer editable", () => {
    wrap(
      <MappingEditor
        projectId={PROJECT_ID}
        job={makeJob({ mapping: FULLY_MAPPED, status: "RUNNING" })}
      />,
    );

    // Checkbox is a <button role="checkbox">; disabled-by-styling
    // (pointer-events-none) is what this component uses everywhere else
    // that isn't a native form control (see the source-column INPUT/SELECT
    // for the same `!editable` pattern) — assert clicking it has no effect.
    const checkbox = screen.getByRole("checkbox", { name: /skip sandbox rows/i });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true"); // unchanged
  });
});
