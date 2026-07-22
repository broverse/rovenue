import { useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { ChevronDown, Layers, Plus, Trash2, X } from "lucide-react";
import type {
  ButtonNode,
  ImageNode,
  NodeOverride,
  NodeSize,
  OverrideCondition,
  PackageListNode,
  PaywallNode,
  PurchaseButtonNode,
  SpacerNode,
  StackNode,
  TextNode,
  ThemeColor,
} from "@rovenue/shared/paywall";
import { OVERRIDABLE_PROP_KEYS } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../ui/checkbox";
import { NativeSelect } from "../../ui/native-select";
import { ColorSwatchInput } from "../funnel-builder/color-swatch-input";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { NODE_TYPE_LABEL } from "./node-meta";

const INPUT_CLASS =
  "h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500";

export const PropertiesPanel = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const node = vm.selectedNode;

  if (!node) {
    return (
      <aside className="flex w-[320px] flex-shrink-0 flex-col items-center justify-center border-l border-rv-divider bg-rv-bg px-6 text-center">
        <div className="rounded-lg border border-dashed border-rv-divider bg-rv-c2 px-4 py-6">
          <div className="text-[13px] font-medium text-foreground">
            {t("paywalls.builder.properties.emptyTitle", "No node selected")}
          </div>
          <div className="mt-1 text-[11px] text-rv-mute-500">
            {t(
              "paywalls.builder.properties.emptyBody",
              "Pick a node from the layer tree or click one in the canvas to edit it here.",
            )}
          </div>
        </div>
      </aside>
    );
  }

  const isRoot = node.id === vm.config.root.id;

  return (
    <aside className="flex w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
        <div className="min-w-0">
          <h3 className="m-0 text-[13px] font-semibold">
            {t(`paywalls.builder.nodeTypes.${node.type}`, NODE_TYPE_LABEL[node.type])}
          </h3>
          <div className="mt-0.5 truncate font-rv-mono text-[10px] text-rv-mute-500">{node.id}</div>
        </div>
        {!isRoot && (
          <button
            type="button"
            onClick={() => vm.removeNode(node.id)}
            title={t("paywalls.builder.properties.delete", "Delete node")}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-danger/10 hover:text-rv-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="flex-1">
        {node.type === "stack" && <StackEditor node={node} />}
        {node.type === "text" && <TextEditor node={node} />}
        {node.type === "image" && <ImageEditor node={node} />}
        {node.type === "button" && <ButtonEditor node={node} />}
        {node.type === "packageList" && <PackageListEditor node={node} />}
        {node.type === "purchaseButton" && <PurchaseButtonEditor node={node} />}
        {node.type === "spacer" && <SpacerEditor node={node} />}
        <OverridesSection node={node} />
      </div>
    </aside>
  );
});

// =============================================================
// Per-type editors
// =============================================================

function StackEditor({ node }: { node: StackNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<StackNode>) => vm.updateNode<StackNode>(node.id, patch);

  return (
    <>
      <Section title={t("paywalls.builder.properties.layout", "Layout")} defaultOpen>
        <Field label={t("paywalls.builder.properties.axis", "Axis")}>
          <Segmented
            value={node.axis}
            onChange={(v) => set({ axis: v })}
            options={[
              { value: "v", label: t("paywalls.builder.properties.axisV", "Vertical") },
              { value: "h", label: t("paywalls.builder.properties.axisH", "Horizontal") },
              { value: "z", label: t("paywalls.builder.properties.axisZ", "Layered") },
            ]}
          />
        </Field>
        <NumberField
          className="mt-3"
          label={t("paywalls.builder.properties.spacing", "Spacing")}
          value={node.spacing}
          onChange={(v) => set({ spacing: v })}
        />
        <AlignField className="mt-3" value={node.align} onChange={(v) => set({ align: v })} />
        <PaddingField className="mt-3" value={node.padding} onChange={(v) => set({ padding: v })} />
      </Section>
      <Section title={t("paywalls.builder.properties.size", "Size")}>
        <SizeField
          label={t("paywalls.builder.properties.width", "Width")}
          value={node.size?.width}
          onChange={(v) => set({ size: { ...node.size, width: v } })}
        />
        <SizeField
          className="mt-3"
          label={t("paywalls.builder.properties.height", "Height")}
          value={node.size?.height}
          onChange={(v) => set({ size: { ...node.size, height: v } })}
        />
      </Section>
      <Section title={t("paywalls.builder.properties.appearance", "Appearance")}>
        <ThemeColorField
          label={t("paywalls.builder.properties.background", "Background")}
          value={node.background}
          onChange={(v) => set({ background: v })}
        />
        <NumberField
          className="mt-3"
          label={t("paywalls.builder.properties.cornerRadius", "Corner radius")}
          value={node.cornerRadius}
          onChange={(v) => set({ cornerRadius: v })}
        />
      </Section>
    </>
  );
}

function TextEditor({ node }: { node: TextNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<TextNode>) => vm.updateNode<TextNode>(node.id, patch);

  return (
    <>
      <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
        <LocalizedTextField label={t("paywalls.builder.properties.text", "Text")} locKey={node.key} />
      </Section>
      <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
        <Field label={t("paywalls.builder.properties.role", "Role")}>
          <Segmented
            value={node.role}
            onChange={(v) => set({ role: v })}
            options={[
              { value: "title", label: t("paywalls.builder.properties.roleTitle", "Title") },
              { value: "subtitle", label: t("paywalls.builder.properties.roleSubtitle", "Subtitle") },
              { value: "body", label: t("paywalls.builder.properties.roleBody", "Body") },
              { value: "caption", label: t("paywalls.builder.properties.roleCaption", "Caption") },
            ]}
          />
        </Field>
        <AlignField className="mt-3" value={node.align} onChange={(v) => set({ align: v })} />
        <ThemeColorField
          className="mt-3"
          label={t("paywalls.builder.properties.color", "Color")}
          value={node.color}
          onChange={(v) => set({ color: v })}
        />
      </Section>
    </>
  );
}

function ImageEditor({ node }: { node: ImageNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ImageNode>) => vm.updateNode<ImageNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.image", "Image")} defaultOpen>
      <Field label={t("paywalls.builder.properties.urlLight", "URL (light)")}>
        <input
          value={node.url.light}
          onChange={(e) => set({ url: { ...node.url, light: e.currentTarget.value } })}
          placeholder="https://cdn.example.com/photo.png"
          className={INPUT_CLASS}
        />
      </Field>
      <Field className="mt-3" label={t("paywalls.builder.properties.urlDark", "URL (dark)")}>
        <input
          value={node.url.dark ?? ""}
          onChange={(e) => set({ url: { ...node.url, dark: e.currentTarget.value || undefined } })}
          placeholder="https://cdn.example.com/photo-dark.png"
          className={INPUT_CLASS}
        />
      </Field>
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.height", "Height")}
        value={node.height}
        onChange={(v) => set({ height: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.cornerRadius", "Corner radius")}
        value={node.cornerRadius}
        onChange={(v) => set({ cornerRadius: v })}
      />
      <Field className="mt-3" label={t("paywalls.builder.properties.alt", "Alt text")}>
        <input
          value={node.alt ?? ""}
          onChange={(e) => set({ alt: e.currentTarget.value || undefined })}
          className={INPUT_CLASS}
        />
      </Field>
    </Section>
  );
}

function ButtonEditor({ node }: { node: ButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ButtonNode>) => vm.updateNode<ButtonNode>(node.id, patch);

  return (
    <>
      <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
        <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
      </Section>
      <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
        <Field label={t("paywalls.builder.properties.buttonStyle", "Style")}>
          <Segmented
            value={node.style}
            onChange={(v) => set({ style: v })}
            options={[
              { value: "primary", label: t("paywalls.builder.properties.buttonStylePrimary", "Primary") },
              { value: "secondary", label: t("paywalls.builder.properties.buttonStyleSecondary", "Secondary") },
              { value: "plain", label: t("paywalls.builder.properties.buttonStylePlain", "Plain") },
            ]}
          />
        </Field>
      </Section>
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
    </>
  );
}

function PackageListEditor({ node }: { node: PackageListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PackageListNode>) => vm.updateNode<PackageListNode>(node.id, patch);
  const offeringPackageIds = vm.paywall?.offeringPackageIds ?? [];

  const toggle = (id: string) => {
    const has = node.packageIds.includes(id);
    const packageIds = has ? node.packageIds.filter((p) => p !== id) : [...node.packageIds, id];
    const defaultSelected =
      node.defaultSelected && !packageIds.includes(node.defaultSelected) ? undefined : node.defaultSelected;
    set({ packageIds, defaultSelected });
  };

  return (
    <>
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
          {offeringPackageIds.map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
              <Checkbox checked={node.packageIds.includes(id)} onChange={() => toggle(id)} ariaLabel={id} />
              <span className="font-rv-mono text-[11px]">{id}</span>
            </label>
          ))}
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
            {(node.packageIds.length ? node.packageIds : offeringPackageIds).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field className="mt-3" label={t("paywalls.builder.properties.cellLayout", "Layout")}>
          <Segmented
            value={node.cellLayout}
            onChange={(v) => set({ cellLayout: v })}
            options={[
              { value: "row", label: t("paywalls.builder.properties.cellLayoutRow", "Row") },
              { value: "column", label: t("paywalls.builder.properties.cellLayoutColumn", "Column") },
            ]}
          />
        </Field>
      </Section>
      <Section title={t("paywalls.builder.properties.cellTemplate", "Cell template")}>
        <div className="mb-2 text-[11px] text-rv-mute-500">
          {t(
            "paywalls.builder.properties.cellTemplateHint",
            "Replace the built-in name + price cell with a custom subtree, editable in the layer tree.",
          )}
        </div>
        {node.cellTemplate ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-foreground">
              <Layers size={12} className="text-rv-mute-500" />
              {t("paywalls.builder.properties.cellTemplateActive", "Custom template active")}
            </span>
            <button
              type="button"
              onClick={() => vm.setCellTemplate(node.id, "none")}
              title={t("paywalls.builder.properties.cellTemplateRemove", "Remove cell template")}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => vm.setCellTemplate(node.id, "default")}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-rv-divider px-2.5 text-[12px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-foreground"
          >
            <Plus size={12} />
            {t("paywalls.builder.properties.cellTemplateAdd", "Add default template")}
          </button>
        )}
      </Section>
    </>
  );
}

function PurchaseButtonEditor({ node }: { node: PurchaseButtonNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
    </Section>
  );
}

function SpacerEditor({ node }: { node: SpacerNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.spacer", "Spacer")} defaultOpen>
      <NumberField
        label={t("paywalls.builder.properties.size", "Size")}
        value={node.size}
        onChange={(v) => vm.updateNode<SpacerNode>(node.id, { size: v })}
      />
    </Section>
  );
}

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
};

function OverridesSection({ node }: { node: PaywallNode }) {
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
      return (
        <ThemeColorField
          label={label}
          value={value as ThemeColor | undefined}
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

// =============================================================
// Shared field widgets
// =============================================================

/** Text/button/purchaseButton label editing — writes into `config.localizations[editLocale][locKey]`. */
function LocalizedTextField({ label, locKey }: { label: string; locKey: string }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const value = vm.config.localizations[vm.editLocale]?.[locKey] ?? "";
  const defaultValue = vm.config.localizations[vm.defaultLocale]?.[locKey] ?? "";
  const placeholder = vm.editLocale === vm.defaultLocale ? undefined : defaultValue || undefined;

  return (
    <Field label={label}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => vm.setLocaleText(locKey, vm.editLocale, e.currentTarget.value)}
        className={INPUT_CLASS}
      />
      <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
        {t("paywalls.builder.properties.locKeyHint", "Key")}: {locKey} · {vm.editLocale.toUpperCase()}
      </div>
    </Field>
  );
}

function ThemeColorField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: ThemeColor | undefined;
  onChange: (next: ThemeColor | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const setLight = (hex: string) => {
    const dark = value?.dark;
    if (!hex && !dark) {
      onChange(undefined);
      return;
    }
    onChange({ light: hex, dark });
  };
  const setDark = (hex: string) => {
    const light = value?.light ?? "";
    if (!light && !hex) {
      onChange(undefined);
      return;
    }
    onChange({ light, dark: hex || undefined });
  };

  return (
    <Field label={label} className={className}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
            {t("paywalls.builder.properties.colorLight", "Light")}
          </div>
          <ColorSwatchInput size="sm" value={value?.light ?? ""} onChange={setLight} />
        </div>
        <div>
          <div className="mb-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
            {t("paywalls.builder.properties.colorDark", "Dark")}
          </div>
          <ColorSwatchInput size="sm" value={value?.dark ?? ""} onChange={setDark} />
        </div>
      </div>
    </Field>
  );
}

function AlignField({
  value,
  onChange,
  className,
}: {
  value: "start" | "center" | "end" | undefined;
  onChange: (v: "start" | "center" | "end") => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("paywalls.builder.properties.align", "Align")} className={className}>
      <Segmented
        value={value ?? "start"}
        onChange={onChange}
        options={[
          { value: "start", label: t("paywalls.builder.properties.alignStart", "Start") },
          { value: "center", label: t("paywalls.builder.properties.alignCenter", "Center") },
          { value: "end", label: t("paywalls.builder.properties.alignEnd", "End") },
        ]}
      />
    </Field>
  );
}

function PaddingField({
  value,
  onChange,
  className,
}: {
  value: StackNode["padding"];
  onChange: (next: StackNode["padding"]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const set = (key: "t" | "r" | "b" | "l") => (v: number | undefined) => {
    const next = { ...(value ?? {}) };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <Field label={t("paywalls.builder.properties.padding", "Padding")} className={className}>
      <div className="grid grid-cols-4 gap-1.5">
        <MiniNumber label="T" value={value?.t} onChange={set("t")} />
        <MiniNumber label="R" value={value?.r} onChange={set("r")} />
        <MiniNumber label="B" value={value?.b} onChange={set("b")} />
        <MiniNumber label="L" value={value?.l} onChange={set("l")} />
      </div>
    </Field>
  );
}

function MiniNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="flex flex-col items-center gap-1">
      <span className="font-rv-mono text-[9px] text-rv-mute-500">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-7 w-full rounded border border-rv-divider bg-rv-c2 px-1 text-center font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
      />
    </label>
  );
}

function SizeField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: NodeSize | undefined;
  onChange: (v: NodeSize | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const mode: "fit" | "fill" | "custom" =
    value === "fit" ? "fit" : value === "fill" ? "fill" : typeof value === "number" ? "custom" : "fit";

  return (
    <Field label={label} className={className}>
      <div className="flex items-center gap-1.5">
        <Segmented
          value={mode}
          onChange={(v) => onChange(v === "custom" ? (typeof value === "number" ? value : 100) : v)}
          options={[
            { value: "fit", label: t("paywalls.builder.properties.sizeFit", "Fit") },
            { value: "fill", label: t("paywalls.builder.properties.sizeFill", "Fill") },
            { value: "custom", label: t("paywalls.builder.properties.sizeCustom", "Px") },
          ]}
        />
        {mode === "custom" && (
          <input
            type="number"
            value={typeof value === "number" ? value : ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              onChange(v === "" ? undefined : Number(v));
            }}
            className="h-7 w-16 rounded border border-rv-divider bg-rv-c2 px-1 text-center font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
          />
        )}
      </div>
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
      />
    </Field>
  );
}

// =============================================================
// Layout primitives — local copies of funnel-builder's private
// Section/Field/Segmented (not exported there), same visual language.
// =============================================================

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-rv-divider">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left transition hover:bg-rv-c2"
      >
        <h4 className="m-0 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          {title}
        </h4>
        <ChevronDown
          size={12}
          className={cn("text-rv-mute-500 transition-transform duration-150", open ? "rotate-0" : "-rotate-90")}
        />
      </button>
      {open && <div className="px-4 pb-3.5">{children}</div>}
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      className="grid gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer rounded px-1.5 py-1 text-[11px] font-medium transition",
            value === o.value ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
