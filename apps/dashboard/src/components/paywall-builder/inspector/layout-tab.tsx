import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Layers, Plus, Trash2 } from "lucide-react";
import type {
  ImageNode,
  PackageListNode,
  PaywallNode,
  SpacerNode,
  StackNode,
} from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { AlignField, NumberField, PaddingField, SizeField } from "./fields";
import { Field, Section, Segmented } from "./primitives";

// =============================================================
// Layout — how a node arranges itself and its children. `align` lives
// here for a stack (it aligns children) but on Style for text (it
// aligns glyphs): same widget, different meaning.
// =============================================================

export const LayoutTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "stack":
      return <StackLayout node={node} />;
    case "image":
      return <ImageLayout node={node} />;
    case "packageList":
      return <PackageListLayout node={node} />;
    case "spacer":
      return <SpacerLayout node={node} />;
    default:
      return null;
  }
});

function StackLayout({ node }: { node: StackNode }) {
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
    </>
  );
}

function ImageLayout({ node }: { node: ImageNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ImageNode>) => vm.updateNode<ImageNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.size", "Size")} defaultOpen>
      <NumberField
        label={t("paywalls.builder.properties.height", "Height")}
        value={node.height}
        onChange={(v) => set({ height: v })}
      />
    </Section>
  );
}

function PackageListLayout({ node }: { node: PackageListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PackageListNode>) => vm.updateNode<PackageListNode>(node.id, patch);

  return (
    <>
      <Section title={t("paywalls.builder.properties.cells", "Cells")} defaultOpen>
        <Field label={t("paywalls.builder.properties.cellLayout", "Layout")}>
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

function SpacerLayout({ node }: { node: SpacerNode }) {
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
