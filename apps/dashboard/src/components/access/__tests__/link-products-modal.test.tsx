import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../../i18n/config";

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock("../../../lib/hooks/useProjectProducts", () => ({
  useUpdateProduct: () => ({ mutateAsync }),
}));

import { LinkProductsModal } from "../link-products-modal";

const access = {
  id: "acc_1",
  identifier: "premium",
  displayName: "Premium",
  description: null,
} as unknown as DashboardAccessRow;

function product(over: Partial<DashboardProductRow>): DashboardProductRow {
  return {
    id: "prod",
    identifier: "prod",
    type: "SUBSCRIPTION",
    displayName: "Product",
    storeIds: {},
    accessIds: [],
    isActive: true,
    metadata: {},
    createdAt: "",
    updatedAt: "",
    ...over,
  } as DashboardProductRow;
}

const A = product({ id: "a", identifier: "alpha", displayName: "Alpha", accessIds: ["acc_1"] });
const B = product({ id: "b", identifier: "beta", displayName: "Beta", accessIds: [] });

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => mutateAsync.mockClear());

describe("LinkProductsModal", () => {
  it("pre-checks products already granting the access", () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    // filtered order matches products order: [A, B]
    expect(boxes[0]).toHaveAttribute("aria-checked", "true"); // Alpha is linked
    expect(boxes[1]).toHaveAttribute("aria-checked", "false"); // Beta is not
  });

  it("patches only changed products on save (link + unlink)", async () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]); // uncheck Alpha -> unlink
    fireEvent.click(boxes[1]); // check Beta -> link
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync).toHaveBeenCalledWith({ id: "a", accessIds: [] });
    expect(mutateAsync).toHaveBeenCalledWith({ id: "b", accessIds: ["acc_1"] });
  });

  it("removing an access leaves the product's other access ids intact", async () => {
    const C = product({
      id: "c",
      identifier: "gamma",
      displayName: "Gamma",
      accessIds: ["acc_1", "acc_2"],
    });
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[C]} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]); // uncheck Gamma -> unlink acc_1 only
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ id: "c", accessIds: ["acc_2"] }),
    );
  });

  it("does not patch unchanged products", async () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    // Save without touching anything
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(mutateAsync).not.toHaveBeenCalled());
  });

  it("filters the list by search", () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText(/search products/i), { target: { value: "beta" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("shows an error on save failure", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("Network error"));
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[1]); // toggle Beta to trigger a patch
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
  });
});
