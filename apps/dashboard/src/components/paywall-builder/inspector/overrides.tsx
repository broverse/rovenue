import { useService } from "impair";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type {
  NodeOverride,
  OverrideCondition,
  PaywallNode,
  ThemeColor,
} from "@rovenue/shared/paywall";
import { ICON_NAMES, OVERRIDABLE_PROP_KEYS } from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { AlignField, NumberField, SelectField, ThemeColorField } from "./fields";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";

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
  style: "Style",
  thickness: "Thickness",
  name: "Icon",
};

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
}: {
  node: PaywallNode;
  propKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = OVERRIDE_PROP_LABEL[propKey] ?? propKey;

  switch (`${node.type}.${propKey}`) {
    case "stack.spacing":
    case "stack.cornerRadius":
    case "image.cornerRadius":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          onChange={(v) => onChange(v)}
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
    case "divider.color":
    case "icon.color":
      return (
        <ThemeColorField
          label={label}
          value={value as ThemeColor | undefined}
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
    default:
      return null;
  }
}

