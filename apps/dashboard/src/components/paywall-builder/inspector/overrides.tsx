import { useService } from "impair";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type {
  NodeBorder,
  NodeOverride,
  OverrideCondition,
  PaywallNode,
  ThemeColor,
  ThemeUrl,
} from "@rovenue/shared/paywall";
import { ICON_NAMES, OVERRIDABLE_PROP_KEYS, SOCIAL_PROOF_MAX_RATING } from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { AlignField, BorderField, NumberField, SelectField, ThemeColorField, ThemeUrlField } from "./fields";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";

/** Ratings never go negative — same floor `content-tab.tsx`'s SocialProof field clamps to. */
const SOCIAL_PROOF_MIN_RATING = 0;

// =============================================================
// Overrides (Phase D2) — conditional prop swaps. Available on every
// node type whose OVERRIDABLE_PROP_KEYS is non-empty (packageList
// and spacer have none, so the section is a no-op there). The
// condition is fixed at creation time (one of the two known
// `OverrideCondition["kind"]` values); the props sub-form below is
// deliberately SPARSE — it only renders a field editor for that node
// type's own overridable keys, reusing the same Field/NumberField/
// AlignField/ThemeColorField/Segmented widgets the full properties
// editor above uses, never the entire editor.
// =============================================================

const OVERRIDE_PROP_LABEL: Record<string, string> = {
  spacing: "Spacing",
  align: "Align",
  background: "Background",
  cornerRadius: "Corner radius",
  key: "Key",
  color: "Color",
  labelKey: "Label key",
  trialLabelKey: "Trial-aware label",
  style: "Style",
  thickness: "Thickness",
  name: "Icon",
  iconColor: "Icon color",
  connectorColor: "Connector color",
  rating: "Rating",
  starColor: "Star color",
  indicatorColor: "Indicator color",
  url: "URL",
  posterUrl: "Poster URL",
  labelColor: "Label color",
  border: "Border",
};

/**
 * Every `${node.type}.${propKey}` combination `OVERRIDABLE_PROP_KEYS`
 * declares — derived directly from the schema's own type rather than
 * hand-restated here. Before this, the union below was a hand-written
 * literal list with no compile-time link back to the schema: the schema's
 * arrays were typed as plain `readonly string[]` (not literal tuples), so
 * nothing forced the two to stay in sync, and `purchaseButton.trialLabelKey`
 * fell out of the hand-written union silently.
 *
 * Now this union IS the schema (schema.ts's `OVERRIDABLE_PROP_KEYS` is typed
 * with `as const satisfies Record<...>`, which keeps each array's literal
 * string-tuple type instead of widening it to `readonly string[]`). That
 * makes the `never` check below do double duty: it already proved the
 * switch is exhaustive over this union; now that the union is defined as
 * the schema, exhaustiveness over the union IS exhaustiveness over the
 * schema — a prop added to `OVERRIDABLE_PROP_KEYS` without a matching case
 * here fails to compile at that check, naming the missing combo.
 */
type OverridablePropCombo = {
  [K in keyof typeof OVERRIDABLE_PROP_KEYS]: `${K}.${(typeof OVERRIDABLE_PROP_KEYS)[K][number]}`;
}[keyof typeof OVERRIDABLE_PROP_KEYS];

export function OverridesSection({ node }: { node: PaywallNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const allowedKeys = OVERRIDABLE_PROP_KEYS[node.type];
  if (allowedKeys.length === 0) return null;

  const overrides = node.overrides ?? [];

  return (
    <Section title={t("paywalls.builder.properties.overrides", "Overrides")}>
      <div className="mb-2 text-[11px] text-rv-mute-500">
        {t(
          "paywalls.builder.properties.overridesHint",
          "Swap props when a package is intro-eligible, or when it's the selected package inside a cell template.",
        )}
      </div>
      {overrides.length === 0 && (
        <div className="mb-2 text-[11px] text-rv-mute-500">
          {t("paywalls.builder.properties.overridesEmpty", "No overrides yet.")}
        </div>
      )}
      {overrides.map((override, index) => (
        <OverrideRow key={index} node={node} override={override} index={index} allowedKeys={allowedKeys} />
      ))}
      <div className="mt-1 flex gap-1.5">
        <button
          type="button"
          onClick={() => vm.addOverride(node.id, "introEligible")}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-dashed border-rv-divider px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-foreground"
        >
          <Plus size={11} />
          {t("paywalls.builder.properties.overrideAddIntroEligible", "Intro eligible")}
        </button>
        <button
          type="button"
          onClick={() => vm.addOverride(node.id, "selected")}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-dashed border-rv-divider px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-foreground"
        >
          <Plus size={11} />
          {t("paywalls.builder.properties.overrideAddSelected", "Selected (in cell)")}
        </button>
      </div>
    </Section>
  );
}

function overrideConditionLabel(
  kind: OverrideCondition["kind"],
  t: (key: string, fallback: string) => string,
): string {
  return kind === "introEligible"
    ? t("paywalls.builder.properties.overrideAddIntroEligible", "Intro eligible")
    : t("paywalls.builder.properties.overrideAddSelected", "Selected (in cell)");
}

function OverrideRow({
  node,
  override,
  index,
  allowedKeys,
}: {
  node: PaywallNode;
  override: NodeOverride;
  index: number;
  allowedKeys: readonly string[];
}) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();

  return (
    <div className="mb-3 rounded-md border border-rv-divider bg-rv-c2 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-600">
          {overrideConditionLabel(override.when.kind, t)}
        </span>
        <button
          type="button"
          onClick={() => vm.removeOverride(node.id, index)}
          title={t("paywalls.builder.properties.overrideRemove", "Remove override")}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
        >
          <X size={11} />
        </button>
      </div>
      <div className="flex flex-col gap-2.5">
        {allowedKeys.map((key) => (
          <OverridePropField
            key={key}
            node={node}
            propKey={key}
            projectId={vm.projectId}
            value={override.props[key]}
            onChange={(v) => vm.updateOverrideProps(node.id, index, { [key]: v })}
          />
        ))}
      </div>
    </div>
  );
}

function OverridePropField({
  node,
  propKey,
  value,
  onChange,
  projectId,
}: {
  node: PaywallNode;
  propKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  projectId: string;
}) {
  const label = OVERRIDE_PROP_LABEL[propKey] ?? propKey;
  const combo = `${node.type}.${propKey}` as OverridablePropCombo;

  switch (combo) {
    case "stack.spacing":
    case "stack.cornerRadius":
    case "image.cornerRadius":
    case "text.cornerRadius":
    case "button.cornerRadius":
    case "purchaseButton.cornerRadius":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "socialProof.rating":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) =>
            onChange(
              v === undefined ? undefined : Math.min(SOCIAL_PROOF_MAX_RATING, Math.max(SOCIAL_PROOF_MIN_RATING, v)),
            )
          }
        />
      );
    case "stack.align":
    case "text.align":
      return (
        <AlignField
          value={value === "start" || value === "center" || value === "end" ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "stack.background":
    case "text.color":
    case "text.background":
    case "button.background":
    case "button.labelColor":
    case "purchaseButton.background":
    case "purchaseButton.labelColor":
    case "divider.color":
    case "icon.color":
    case "featureList.iconColor":
    case "timeline.connectorColor":
    case "socialProof.starColor":
    case "stickyFooter.background":
    case "countdown.color":
    case "carousel.indicatorColor":
      return (
        <ThemeColorField
          label={label}
          value={value as ThemeColor | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "stack.border":
    case "image.border":
    case "button.border":
    case "purchaseButton.border":
      return (
        <BorderField
          label={label}
          value={value as NodeBorder | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "divider.thickness":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "icon.name":
      return (
        <SelectField
          label={label}
          value={typeof value === "string" && ICON_NAMES.includes(value) ? value : ICON_NAMES[0]!}
          options={ICON_NAMES}
          onChange={(v) => onChange(v)}
        />
      );
    case "text.key":
    case "button.labelKey":
    case "purchaseButton.labelKey":
      return (
        <Field label={label}>
          <input
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.currentTarget.value)}
            placeholder={label}
            className={INPUT_CLASS}
          />
        </Field>
      );
    case "purchaseButton.trialLabelKey":
      // Mirrors the Binding tab's base `trialLabelKey` field
      // (`binding-tab.tsx`'s `PurchaseButtonBinding`) exactly: no
      // placeholder (that field has none either — it's a key-editing
      // field, not free text with an example), and an empty input
      // writes `undefined`, never `""`, same as `set({ trialLabelKey:
      // e.currentTarget.value || undefined })` there. A user overriding
      // this prop should meet the same rules they already met on the
      // base value.
      return (
        <Field label={label}>
          <input
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.currentTarget.value || undefined)}
            className={INPUT_CLASS}
          />
        </Field>
      );
    case "button.style":
      return (
        <Segmented
          value={value === "primary" || value === "secondary" || value === "plain" ? value : "secondary"}
          onChange={(v) => onChange(v)}
          options={[
            { value: "primary", label: "Primary" },
            { value: "secondary", label: "Secondary" },
            { value: "plain", label: "Plain" },
          ]}
        />
      );
    case "video.url":
      return (
        <ThemeUrlField
          labelLight={`${label} (light)`}
          labelDark={`${label} (dark)`}
          value={value as ThemeUrl | undefined}
          onChange={(v) => onChange(v)}
          kind="video"
          projectId={projectId}
        />
      );
    case "video.posterUrl":
      // A poster is a still frame — the picker here browses IMAGE
      // assets, matching content-tab.tsx's identical `posterUrl` field.
      return (
        <ThemeUrlField
          labelLight={`${label} (light)`}
          labelDark={`${label} (dark)`}
          value={value as ThemeUrl | undefined}
          onChange={(v) => onChange(v)}
          kind="image"
          projectId={projectId}
        />
      );
    case "lottie.url":
      return (
        <ThemeUrlField
          labelLight={`${label} (light)`}
          labelDark={`${label} (dark)`}
          value={value as ThemeUrl | undefined}
          onChange={(v) => onChange(v)}
          kind="lottie"
          projectId={projectId}
        />
      );
    default: {
      const exhaustive: never = combo;
      return exhaustive;
    }
  }
}

