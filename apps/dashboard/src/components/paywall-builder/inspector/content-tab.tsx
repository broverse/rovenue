import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import {
  FEATURE_ROW_DEFAULT_INCLUDED,
  ICON_NAMES,
  SOCIAL_PROOF_MAX_RATING,
  type ButtonNode,
  type DividerNode,
  type FeatureListNode,
  type FeatureRow,
  type IconNode,
  type ImageNode,
  type PaywallNode,
  type PurchaseButtonNode,
  type SocialProofNode,
  type TextNode,
  type TimelineNode,
  type TimelineRow,
} from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { LocalizedTextField, NumberField, SelectField } from "./fields";
import { Field, INPUT_CLASS, Section } from "./primitives";
import { RowListEditor } from "./row-list-editor";

/** A featureList/timeline row (or socialProof) has no rating floor below zero. */
const SOCIAL_PROOF_MIN_RATING = 0;
/** The row-icon picker's "let the renderer pick" option — an empty selection,
 *  never a real registry name, so it can't collide with `ICON_NAMES`. */
const ROW_ICON_AUTO_VALUE = "";

// =============================================================
// Content — what the node actually shows. Localized strings live
// here, which is why the Content tab carries the UNKNOWN_LOC_KEY and
// EMPTY_LOC_VALUE dots.
// =============================================================

export const ContentTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "text":
      return <TextContent node={node} />;
    case "image":
      return <ImageContent node={node} />;
    case "button":
      return <ButtonContent node={node} />;
    case "purchaseButton":
      return <PurchaseButtonContent node={node} />;
    case "divider":
      return <DividerContent node={node} />;
    case "icon":
      return <IconContent node={node} />;
    case "featureList":
      return <FeatureListContent node={node} />;
    case "timeline":
      return <TimelineContent node={node} />;
    case "socialProof":
      return <SocialProofContent node={node} />;
    default:
      return null;
  }
});

function TextContent({ node }: { node: TextNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.text", "Text")} locKey={node.key} />
    </Section>
  );
}

function ImageContent({ node }: { node: ImageNode }) {
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

function ButtonContent({ node }: { node: ButtonNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
    </Section>
  );
}

function PurchaseButtonContent({ node }: { node: PurchaseButtonNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
    </Section>
  );
}

function DividerContent({ node }: { node: DividerNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<DividerNode>) => vm.updateNode<DividerNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.divider", "Divider")} defaultOpen>
      <NumberField
        label={t("paywalls.builder.properties.thickness", "Thickness")}
        value={node.thickness}
        onChange={(v) => set({ thickness: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.inset", "Inset")}
        value={node.inset}
        onChange={(v) => set({ inset: v })}
      />
    </Section>
  );
}

function IconContent({ node }: { node: IconNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<IconNode>) => vm.updateNode<IconNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.icon", "Icon")} defaultOpen>
      <SelectField
        label={t("paywalls.builder.properties.iconName", "Icon")}
        value={node.name}
        options={ICON_NAMES}
        onChange={(v) => set({ name: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.size", "Size")}
        value={node.size}
        onChange={(v) => set({ size: v })}
      />
    </Section>
  );
}

/**
 * A row's own `icon` picker — like `IconContent`'s, but the value is
 * OPTIONAL: an unset row falls back to the renderer's included/excluded
 * default glyph (see `FEATURE_ROW_DEFAULT_ICON`/`FEATURE_ROW_EXCLUDED_ICON`/
 * `TIMELINE_ROW_DEFAULT_ICON`), so the picker needs an explicit "let the
 * renderer decide" option `SelectField` (a required string) has no room for.
 */
function RowIconField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={label}>
      <select
        value={value ?? ROW_ICON_AUTO_VALUE}
        onChange={(e) => onChange(e.currentTarget.value || undefined)}
        className={INPUT_CLASS}
      >
        <option value={ROW_ICON_AUTO_VALUE}>
          {t("paywalls.builder.properties.iconDefault", "Default")}
        </option>
        {ICON_NAMES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function FeatureListContent({ node }: { node: FeatureListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const setRows = (rows: FeatureRow[]) => vm.updateNode<FeatureListNode>(node.id, { rows });

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <RowListEditor<FeatureRow>
        rows={node.rows}
        onChange={setRows}
        newRow={() => ({ labelKey: "" })}
        addLabel={t("paywalls.builder.properties.featureListAddRow", "Add row")}
        renderRow={(row, _index, patch) => (
          <div className="flex flex-col gap-2">
            <Field label={t("paywalls.builder.properties.locKeyLabel", "Key")}>
              <input
                value={row.labelKey}
                onChange={(e) => patch({ labelKey: e.currentTarget.value })}
                placeholder={t("paywalls.builder.properties.locKeyPlaceholder", "e.g. feature_1")}
                className={INPUT_CLASS}
              />
            </Field>
            <RowIconField
              label={t("paywalls.builder.properties.iconName", "Icon")}
              value={row.icon}
              onChange={(v) => patch({ icon: v })}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={row.included ?? FEATURE_ROW_DEFAULT_INCLUDED}
                onChange={(e) => patch({ included: e.currentTarget.checked })}
              />
              {t("paywalls.builder.properties.featureRowIncluded", "Included")}
            </label>
          </div>
        )}
      />
    </Section>
  );
}

function TimelineContent({ node }: { node: TimelineNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const setRows = (rows: TimelineRow[]) => vm.updateNode<TimelineNode>(node.id, { rows });

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <RowListEditor<TimelineRow>
        rows={node.rows}
        onChange={setRows}
        newRow={() => ({ labelKey: "" })}
        addLabel={t("paywalls.builder.properties.timelineAddRow", "Add row")}
        renderRow={(row, _index, patch) => (
          <div className="flex flex-col gap-2">
            <Field label={t("paywalls.builder.properties.locKeyLabel", "Key")}>
              <input
                value={row.labelKey}
                onChange={(e) => patch({ labelKey: e.currentTarget.value })}
                placeholder={t("paywalls.builder.properties.locKeyPlaceholder", "e.g. feature_1")}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label={t("paywalls.builder.properties.timelineCaptionKey", "Caption key (optional)")}>
              <input
                value={row.captionKey ?? ""}
                onChange={(e) => patch({ captionKey: e.currentTarget.value || undefined })}
                className={INPUT_CLASS}
              />
            </Field>
            <RowIconField
              label={t("paywalls.builder.properties.iconName", "Icon")}
              value={row.icon}
              onChange={(v) => patch({ icon: v })}
            />
          </div>
        )}
      />
    </Section>
  );
}

function SocialProofContent({ node }: { node: SocialProofNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<SocialProofNode>) => vm.updateNode<SocialProofNode>(node.id, patch);
  const clampRating = (v: number | undefined) =>
    v === undefined ? undefined : Math.min(SOCIAL_PROOF_MAX_RATING, Math.max(SOCIAL_PROOF_MIN_RATING, v));

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <Field label={t("paywalls.builder.properties.locKeyLabel", "Key")}>
        <input
          value={node.labelKey}
          onChange={(e) => set({ labelKey: e.currentTarget.value })}
          placeholder={t("paywalls.builder.properties.locKeyPlaceholder", "e.g. feature_1")}
          className={INPUT_CLASS}
        />
      </Field>
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.socialProofRating", "Rating")}
        value={node.rating}
        onChange={(v) => set({ rating: clampRating(v) })}
      />
    </Section>
  );
}
