import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import type { ButtonNode, PackageListNode, PaywallNode } from "@rovenue/shared/paywall";
import { cn } from "../../../lib/cn";
import { useOfferingResolvedPrices } from "../../../lib/hooks/useOfferingResolvedPrices";
import { Checkbox } from "../../../ui/checkbox";
import { NativeSelect } from "../../../ui/native-select";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import {
  activePresetId,
  availablePresets,
  buildPriceRows,
  formatMinorAmount,
  periodLabel,
  presetSelection,
  storeBadgeText,
  type PackagePriceRow,
} from "./binding-prices";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";

/** apple > google > stripe: display order for per-store price badges and the default-selected option's amount. */
const STORE_DISPLAY_ORDER = ["apple", "google", "stripe"] as const;
const STORE_LABELS: Readonly<Record<(typeof STORE_DISPLAY_ORDER)[number], string>> = {
  apple: "Apple",
  google: "Google",
  stripe: "Stripe",
};
const PERIOD_CONFLICT_MARKER = "⚠";

/** A row with no id-in-offering match falls back to raw-id-everywhere, matching the pre-fetch shape. */
function emptyPriceRow(packageIdentifier: string): PackagePriceRow {
  return { packageIdentifier, displayName: null, period: null, periodConflict: false, stores: null };
}

/**
 * True when `resolved.data` has nothing to say about this package — the
 * hook is loading, errored, or the id simply isn't in the payload yet.
 * Drives the fallback to today's single id-only row (never a duplicate id).
 */
function isDegradedPriceRow(row: PackagePriceRow): boolean {
  return row.displayName === null && row.period === null && row.stores === null;
}

/** First `ok` store's formatted amount (STORE_DISPLAY_ORDER precedence), else the raw package id. */
function firstOkAmount(row: PackagePriceRow): string {
  if (row.stores) {
    for (const store of STORE_DISPLAY_ORDER) {
      const entry = row.stores[store];
      if (entry?.status === "ok") return formatMinorAmount(entry.amountMinor, entry.currency);
    }
  }
  return row.packageIdentifier;
}

// =============================================================
// Binding — which commerce data, or which behaviour, a node points
// at. Deliberately narrow: how the package list DRAWS its cells is
// Layout's business, not this tab's.
// =============================================================

export const BindingTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "button":
      return <ButtonBinding node={node} />;
    case "packageList":
      return <PackageListBinding node={node} />;
    default:
      return null;
  }
});

function ButtonBinding({ node }: { node: ButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ButtonNode>) => vm.updateNode<ButtonNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.action", "Action")} defaultOpen>
      <Field label={t("paywalls.builder.properties.actionKind", "On tap")}>
        <Segmented
          value={node.action.kind}
          onChange={(kind) =>
            set({
              action:
                kind === "url"
                  ? { kind, url: node.action.kind === "url" ? node.action.url : "" }
                  : { kind },
            })
          }
          options={[
            { value: "close", label: t("paywalls.builder.properties.actionClose", "Close") },
            { value: "url", label: t("paywalls.builder.properties.actionUrl", "Open URL") },
            { value: "restore", label: t("paywalls.builder.properties.actionRestore", "Restore") },
          ]}
        />
      </Field>
      {node.action.kind === "url" && (
        <Field className="mt-3" label={t("paywalls.builder.properties.url", "URL")}>
          <input
            value={node.action.url}
            onChange={(e) => set({ action: { kind: "url", url: e.currentTarget.value } })}
            placeholder="https://example.com/terms"
            className={INPUT_CLASS}
          />
        </Field>
      )}
    </Section>
  );
}

function PackageListBinding({ node }: { node: PackageListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PackageListNode>) => vm.updateNode<PackageListNode>(node.id, patch);
  const offeringPackageIds = vm.paywall?.offeringPackageIds ?? [];

  const resolved = useOfferingResolvedPrices(vm.projectId, vm.paywall?.offeringId ?? null);
  const rows = buildPriceRows(offeringPackageIds, resolved.data);
  const rowById = new Map(rows.map((row) => [row.packageIdentifier, row]));
  const presets = availablePresets(rows);
  const activePreset = activePresetId(rows, node.packageIds);

  const toggle = (id: string) => {
    const has = node.packageIds.includes(id);
    const packageIds = has ? node.packageIds.filter((p) => p !== id) : [...node.packageIds, id];
    const defaultSelected =
      node.defaultSelected && !packageIds.includes(node.defaultSelected) ? undefined : node.defaultSelected;
    set({ packageIds, defaultSelected });
  };

  return (
    <>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-rv-divider px-4 py-3">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => set(presetSelection(rows, preset, node.defaultSelected))}
              className={cn(
                "cursor-pointer rounded px-2 py-1 text-[11px] font-medium transition",
                activePreset === preset.id
                  ? "bg-rv-accent-500 text-white"
                  : "bg-rv-c2 text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t(`paywalls.builder.properties.presetLabel.${preset.id}`, preset.label)}
            </button>
          ))}
          {activePreset === null && (
            <span className="cursor-default rounded px-2 py-1 text-[11px] font-medium text-rv-mute-500">
              {t("paywalls.builder.properties.presetCustom", "Custom")}
            </span>
          )}
        </div>
      )}
      <Section title={t("paywalls.builder.properties.packages", "Packages")} defaultOpen>
        <div className="mb-2 text-[11px] text-rv-mute-500">
          {t(
            "paywalls.builder.properties.packagesHint",
            "Leave all unchecked to show every package in the offering.",
          )}
        </div>
        {offeringPackageIds.length === 0 && (
          <div className="text-[11px] text-rv-mute-500">
            {t("paywalls.builder.properties.packagesEmpty", "This offering has no packages yet.")}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {offeringPackageIds.map((id) => {
            const row = rowById.get(id) ?? emptyPriceRow(id);

            // No resolved data for this id (hook still loading, errored, or
            // simply hasn't returned this package) — the readout is an
            // enhancement layer, never a gate, so this renders EXACTLY
            // today's id-only row: one mono id span, nothing else.
            if (isDegradedPriceRow(row)) {
              return (
                <label key={id} className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                  <Checkbox checked={node.packageIds.includes(id)} onChange={() => toggle(id)} ariaLabel={id} />
                  <span className="font-rv-mono text-[11px]">{id}</span>
                </label>
              );
            }

            const label = periodLabel(row.period);
            return (
              <label key={id} className="flex cursor-pointer items-start gap-2 text-[12px] text-foreground">
                <Checkbox checked={node.packageIds.includes(id)} onChange={() => toggle(id)} ariaLabel={id} />
                <span className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1">
                    <span>{row.displayName ?? id}</span>
                    {label !== null && (
                      <span
                        className="rounded bg-rv-c2 px-1 text-[10px] text-rv-mute-500"
                        title={
                          row.periodConflict
                            ? t(
                                "paywalls.builder.properties.periodConflict",
                                "Stores disagree on this package's billing period",
                              )
                            : undefined
                        }
                      >
                        {label}
                        {row.periodConflict ? ` ${PERIOD_CONFLICT_MARKER}` : ""}
                      </span>
                    )}
                  </span>
                  {row.stores && (
                    <span className="flex flex-wrap gap-1.5 text-[10px] text-rv-mute-500">
                      {STORE_DISPLAY_ORDER.filter((store) => row.stores?.[store]).map((store) => (
                        <span key={store}>
                          {STORE_LABELS[store]} {storeBadgeText(row.stores![store]!)}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="font-rv-mono text-[10px] text-rv-mute-500">{id}</span>
                </span>
              </label>
            );
          })}
        </div>
      </Section>
      <Section title={t("paywalls.builder.properties.selection", "Selection")}>
        <Field label={t("paywalls.builder.properties.defaultSelected", "Default selected")}>
          <NativeSelect
            value={node.defaultSelected ?? ""}
            onChange={(e) => set({ defaultSelected: e.currentTarget.value || undefined })}
          >
            <option value="">
              {t("paywalls.builder.properties.defaultSelectedNone", "First available")}
            </option>
            {(node.packageIds.length ? node.packageIds : offeringPackageIds).map((id) => {
              const row = rowById.get(id) ?? emptyPriceRow(id);
              return (
                <option key={id} value={id}>
                  {`${periodLabel(row.period) ?? id} — ${firstOkAmount(row)}`}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
      </Section>
    </>
  );
}
