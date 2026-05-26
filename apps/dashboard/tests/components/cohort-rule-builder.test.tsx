import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import type { CohortRule } from "@rovenue/shared";
import { CohortRuleBuilder } from "../../src/components/cohorts/cohort-rule-builder";

const translations = {
  cohorts: {
    form: {
      rules: {
        matchPrefix: "Match",
        matchSuffix: "of the following",
        match: { all: "all", any: "any" },
        emptyHint: "No filters — cohort matches every subscriber.",
        addFilter: "Add filter",
        removeFilter: "Remove filter",
        field: {
          country: "Country",
          store: "Store",
          productId: "Product ID",
          purchaseType: "Purchase type",
          firstSeenAfter: "First seen after",
          firstSeenBefore: "First seen before",
        },
        op: {
          eq: "equals",
          in: "in",
          gte: "on or after",
          lte: "on or before",
        },
        placeholder: {
          country: "Country (US, CA, …)",
          store: "apple / google / stripe",
          productId: "product_id",
          purchaseType: "subscription / consumable / …",
          firstSeenAfter: "",
          firstSeenBefore: "",
        },
        preview: "JSON preview",
      },
    },
  },
};

beforeEach(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: { en: { translation: translations } },
    });
  } else {
    i18next.addResourceBundle("en", "translation", translations, true, true);
  }
});

function renderBuilder(rule: CohortRule, onChange = vi.fn()) {
  return render(
    <I18nextProvider i18n={i18next}>
      <CohortRuleBuilder rule={rule} onChange={onChange} />
    </I18nextProvider>,
  );
}

describe("CohortRuleBuilder", () => {
  it("renders the match toggle and an add-filter button", () => {
    const { getByText } = renderBuilder({ match: "all", filters: [] });
    expect(getByText(/match all/i)).toBeTruthy();
    expect(getByText(/add filter/i)).toBeTruthy();
  });

  it("emits a default country filter when 'Add filter' → country is picked", () => {
    const onChange = vi.fn();
    const { getByText } = renderBuilder({ match: "all", filters: [] }, onChange);
    fireEvent.click(getByText(/add filter/i));
    fireEvent.click(getByText(/^country$/i));
    expect(onChange).toHaveBeenCalledWith({
      match: "all",
      filters: [{ field: "country", op: "in", value: [] }],
    });
  });

  it("typing into the chip input emits updated `in` value", () => {
    const onChange = vi.fn();
    const rule: CohortRule = {
      match: "all",
      filters: [{ field: "country", op: "in", value: [] }],
    };
    const { getByPlaceholderText } = renderBuilder(rule, onChange);
    const input = getByPlaceholderText(/country/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "US" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      filters: [{ field: "country", op: "in", value: ["US"] }],
    });
  });

  it("removing the last filter emits filters: []", () => {
    const onChange = vi.fn();
    const rule: CohortRule = {
      match: "all",
      filters: [{ field: "country", op: "in", value: ["US"] }],
    };
    const { getByLabelText } = renderBuilder(rule, onChange);
    fireEvent.click(getByLabelText(/remove filter/i));
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      filters: [],
    });
  });
});
