import { describe, expect, it } from "vitest";
import { selectableStoreIds, toImportItems } from "./import-from-store-modal";
import type { StoreCatalogItem } from "@rovenue/shared";

const items: StoreCatalogItem[] = [
  { storeId: "a", type: "SUBSCRIPTION", name: "A", alreadyImported: false },
  { storeId: "b", type: "CONSUMABLE", name: "B", alreadyImported: true },
  { storeId: "c", type: "NON_CONSUMABLE", name: "C", alreadyImported: false },
];

describe("import-from-store-modal helpers", () => {
  it("selectableStoreIds excludes already-imported", () => {
    expect(selectableStoreIds(items)).toEqual(["a", "c"]);
  });

  it("toImportItems builds import payload from selected ids", () => {
    const out = toImportItems(items, new Set(["a", "c"]));
    expect(out).toEqual([
      { storeId: "a", type: "SUBSCRIPTION" },
      { storeId: "c", type: "NON_CONSUMABLE" },
    ]);
  });
});
