import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Layers, Plus, Trash2 } from "lucide-react";
import type {
  ButtonNode,
  ImageNode,
  PackageListNode,
  PurchaseButtonNode,
  SpacerNode,
  StackNode,
  TextNode,
} from "@rovenue/shared/paywall";
import { Checkbox } from "../../ui/checkbox";
import { NativeSelect } from "../../ui/native-select";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { NODE_TYPE_LABEL } from "./node-meta";
import {
  AlignField,
  LocalizedTextField,
  NumberField,
  PaddingField,
  SizeField,
  ThemeColorField,
} from "./inspector/fields";
import { Field, INPUT_CLASS, Section, Segmented } from "./inspector/primitives";
import { OverridesSection } from "./inspector/overrides";

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
