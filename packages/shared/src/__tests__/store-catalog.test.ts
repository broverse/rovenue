import { describe, expect, it } from "vitest";
import { ERROR_CODE } from "../index";
import type { StoreCatalogItem, DashboardStoreCatalogResponse } from "../dashboard";

describe("store catalog shared contracts", () => {
  it("exposes the new store error codes", () => {
    expect(ERROR_CODE.STORE_NOT_CONFIGURED).toBe("STORE_NOT_CONFIGURED");
    expect(ERROR_CODE.STORE_API_ERROR).toBe("STORE_API_ERROR");
  });

  it("StoreCatalogItem shape compiles and round-trips", () => {
    const item: StoreCatalogItem = {
      storeId: "com.acme.pro_monthly",
      type: "SUBSCRIPTION",
      name: "Pro Monthly",
      alreadyImported: false,
    };
    const res: DashboardStoreCatalogResponse = { items: [item] };
    expect(res.items[0]?.storeId).toBe("com.acme.pro_monthly");
  });
});
