import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
import "../../../i18n/config";
import { AccessDetail } from "../access-detail";

const access = {
  id: "acc_1",
  identifier: "premium",
  displayName: "Premium",
  description: null,
} as unknown as DashboardAccessRow;

const prod = {
  id: "a",
  identifier: "alpha",
  type: "SUBSCRIPTION",
  displayName: "Alpha",
  storeIds: {},
  accessIds: ["acc_1"],
  isActive: true,
  metadata: {},
  createdAt: "",
  updatedAt: "",
} as DashboardProductRow;

function renderDetail(over: Partial<React.ComponentProps<typeof AccessDetail>> = {}) {
  const props = {
    accessRow: access,
    grantingProducts: [prod],
    hasAnyAccess: true,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreate: vi.fn(),
    onLinkProducts: vi.fn(),
    onUnlinkProduct: vi.fn(),
    ...over,
  };
  render(<AccessDetail {...props} />);
  return props;
}

describe("AccessDetail granting products", () => {
  it("fires onLinkProducts when the link button is clicked", () => {
    const props = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /link products/i }));
    expect(props.onLinkProducts).toHaveBeenCalledTimes(1);
  });

  it("fires onUnlinkProduct with the product when its unlink button is clicked", () => {
    const props = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /unlink alpha/i }));
    expect(props.onUnlinkProduct).toHaveBeenCalledWith(prod);
  });

  it("shows the link button even when no products grant the access", () => {
    const props = renderDetail({ grantingProducts: [] });
    fireEvent.click(screen.getByRole("button", { name: /link products/i }));
    expect(props.onLinkProducts).toHaveBeenCalledTimes(1);
  });

  it("renders an unlink error when provided", () => {
    renderDetail({ unlinkError: "Could not unlink" });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not unlink");
  });
});
