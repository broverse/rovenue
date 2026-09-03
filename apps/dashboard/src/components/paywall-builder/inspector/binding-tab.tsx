import { component, useService } from "impair";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ButtonNode, PackageListNode, PaywallNode, PurchaseButtonNode } from "@rovenue/shared/paywall";
import type { ResolvedStoreEntry } from "@rovenue/shared";
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
  STORE_PRECEDENCE,
  storeBadgeText,
  type PackagePriceRow,
} from "./binding-prices";
import { ActionField } from "./fields";
import { Field, INPUT_CLASS, Section } from "./primitives";

/**
 * apple > google > stripe: display order for per-store price badges and the
 * default-selected option's amount. Deliberately the SAME order as
 * binding-prices.ts's STORE_PRECEDENCE (its tie-break order for
 * packagePeriod's majority pick) — re-exported under this tab's own name
 * rather than kept as a second local copy.
 */
const STORE_DISPLAY_ORDER = STORE_PRECEDENCE;
const STORE_LABELS: Readonly<Record<(typeof STORE_DISPLAY_ORDER)[number], string>> = {
  apple: "Apple",
  google: "Google",
  stripe: "Stripe",
};
const PERIOD_CONFLICT_MARKER = "⚠";

/**
 * i18n wrapper around a store entry's badge text. binding-prices.ts stays
 * pure (no t() there — it's unit-tested without mounting a component), so
 * this lives here instead. For the non-"ok" statuses, `storeBadgeText`'s
 * plain-English string is reused as the t() fallback/default rather than
 * restated as a literal a second time — one source of truth for the English
 * copy. The "ok" branch can't reuse it wholesale: the trial suffix needs its
 * day count passed through {{days}} interpolation, not baked into a string.
 */
function storeBadgeLabel(entry: ResolvedStoreEntry, t: TFunction): string {
  switch (entry.status) {
    case "not_configured":
      return t("paywalls.builder.properties.storeBadge.notConfigured", storeBadgeText(entry));
    case "no_mapping":
      return t("paywalls.builder.properties.storeBadge.noMapping", storeBadgeText(entry));
    case "error":
      return t("paywalls.builder.properties.storeBadge.unavailable", storeBadgeText(entry));
    case "ok": {
      const amount = formatMinorAmount(entry.amountMinor, entry.currency);
      const trialSuffix =
        typeof entry.trialDays === "number" && entry.trialDays > 0
          ? t("paywalls.builder.properties.storeBadge.trial", "{{days}}d trial", { days: entry.trialDays })
          : "";
      return [amount, trialSuffix].filter(Boolean).join(" · ");
    }
  }
}

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

/**
 * The "Default selected" <option> text for one non-fully-degraded row (see
 * isDegradedPriceRow for the fully-degraded id-only case, handled by its
 * caller before this ever runs). A row that RESOLVED but has no "ok" store
 * entry anywhere and no metadataPeriod still has both `periodLabel(row.period)`
 * and `firstOkAmount(row)` fall back to the raw id — joining them
 * unconditionally used to print "id — id" (P6 deferred-cleanup finding).
 * Prefers displayName over the id for the label half, and appends
 * " — amount" only when firstOkAmount resolved to something other than the
 * raw id.
 */
function defaultOptionLabel(row: PackagePriceRow, id: string): string {
  const label = periodLabel(row.period) ?? row.displayName ?? id;
  const amount = firstOkAmount(row);
  return amount === id ? label : `${label} — ${amount}`;
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
    case "purchaseButton":
      return <PurchaseButtonBinding node={node} />;
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
      <ActionField value={node.action} onChange={(action) => set({ action })} />
    </Section>
  );
}

/**
 * A purchaseButton always purchases whatever the enclosing packageList (or
 * cellTemplate selection) has selected — there is no id/behaviour to bind,
 * unlike `ButtonBinding`'s action or `PackageListBinding`'s packageIds. The
 * one thing worth configuring here is `trialLabelKey`: which localized key
 * the button falls back to while the selected package's trial/intro period
 * is active (see `resolveCtaLabelKey` in `@rovenue/shared/paywall`). The
 * input mirrors Content tab's optional key-editing fields (e.g.
 * TimelineContent's captionKey) rather than `LocalizedTextField`, because
 * this field edits which KEY is pointed at, not a fixed key's text value.
 */
function PurchaseButtonBinding({ node }: { node: PurchaseButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PurchaseButtonNode>) => vm.updateNode<PurchaseButtonNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.purchase", "Purchase")} defaultOpen>
      <div className="mb-3 text-[11px] text-rv-mute-500">
        {t("paywalls.builder.properties.purchaseBinding", "Purchases the selected package.")}
      </div>
      <Field label={t("paywalls.builder.properties.trialLabelKey", "Trial-aware label")}>
        <input
          value={node.trialLabelKey ?? ""}
          onChange={(e) => set({ trialLabelKey: e.currentTarget.value || undefined })}
          className={INPUT_CLASS}
        />
      </Field>
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
                        {t(`paywalls.builder.properties.periodLabel.${row.period}`, label)}
                        {row.periodConflict ? ` ${PERIOD_CONFLICT_MARKER}` : ""}
                      </span>
                    )}
                  </span>
                  {row.stores && (
                    <span className="flex flex-wrap gap-1.5 text-[10px] text-rv-mute-500">
                      {STORE_DISPLAY_ORDER.filter((store) => row.stores?.[store]).map((store) => (
                        <span key={store}>
                          {STORE_LABELS[store]} {storeBadgeLabel(row.stores![store]!, t)}
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
              // Fully degraded (no resolved data at all) renders the bare id
              // — no enhancement layer. A row that resolved but has no ok
              // store and no period goes through defaultOptionLabel, which
              // guards the same "id — id" trap for that case too.
              return (
                <option key={id} value={id}>
                  {isDegradedPriceRow(row) ? id : defaultOptionLabel(row, id)}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
      </Section>
    </>
  );
}
