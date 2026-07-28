import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import {
  CAROUSEL_DEFAULT_LOOP,
  CAROUSEL_DEFAULT_SHOWS_INDICATOR,
  COUNTDOWN_DEFAULT_ON_EXPIRY,
  FEATURE_ROW_DEFAULT_INCLUDED,
  ICON_NAMES,
  SOCIAL_PROOF_MAX_RATING,
  type ButtonNode,
  type CarouselNode,
  type CountdownNode,
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
import { COUNTDOWN_DEFAULT_DURATION_SECONDS } from "../tree-ops";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { LocalizedTextField, NumberField, SelectField } from "./fields";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";
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
    case "countdown":
      return <CountdownContent node={node} />;
    case "carousel":
      return <CarouselContent node={node} />;
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

/**
 * `endsAt` and `durationSeconds` are mutually exclusive (schema-enforced) —
 * the mode toggle swaps the field shown and clears the other one. A node
 * with neither set (only reachable via hand-edited/legacy data, never via
 * `newNode`) reads as duration mode, same as an unset `endsAt`.
 */
function CountdownContent({ node }: { node: CountdownNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<CountdownNode>) => vm.updateNode<CountdownNode>(node.id, patch);
  const mode: "absolute" | "duration" = node.endsAt !== undefined ? "absolute" : "duration";

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <Field label={t("paywalls.builder.properties.countdownDeadlineMode", "Deadline")}>
        <Segmented
          value={mode}
          onChange={(v) =>
            v === "absolute"
              ? set({ endsAt: node.endsAt, durationSeconds: undefined })
              : set({
                  endsAt: undefined,
                  durationSeconds: node.durationSeconds ?? COUNTDOWN_DEFAULT_DURATION_SECONDS,
                })
          }
          options={[
            { value: "absolute", label: t("paywalls.builder.properties.countdownModeAbsolute", "Fixed date") },
            { value: "duration", label: t("paywalls.builder.properties.countdownModeDuration", "Duration") },
          ]}
        />
      </Field>
      {mode === "absolute" ? (
        <Field className="mt-3" label={t("paywalls.builder.properties.countdownEndsAt", "Ends at")}>
          <input
            type="datetime-local"
            value={node.endsAt ? node.endsAt.slice(0, 16) : ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              set({ endsAt: v ? new Date(v).toISOString() : undefined });
            }}
            className={INPUT_CLASS}
          />
        </Field>
      ) : (
        <NumberField
          className="mt-3"
          label={t("paywalls.builder.properties.countdownDurationSeconds", "Duration (seconds)")}
          value={node.durationSeconds}
          onChange={(v) => set({ durationSeconds: v })}
        />
      )}
      <Field className="mt-3" label={t("paywalls.builder.properties.countdownOnExpiry", "On expiry")}>
        <Segmented
          value={node.onExpiry ?? COUNTDOWN_DEFAULT_ON_EXPIRY}
          onChange={(v) => set({ onExpiry: v })}
          options={[
            { value: "freeze", label: t("paywalls.builder.properties.countdownOnExpiryFreeze", "Freeze at zero") },
            { value: "hide", label: t("paywalls.builder.properties.countdownOnExpiryHide", "Hide") },
          ]}
        />
      </Field>
      <Field
        className="mt-3"
        label={t("paywalls.builder.properties.countdownLabelKey", "Label key (optional)")}
      >
        <input
          value={node.labelKey ?? ""}
          onChange={(e) => set({ labelKey: e.currentTarget.value || undefined })}
          placeholder={t("paywalls.builder.properties.locKeyPlaceholder", "e.g. feature_1")}
          className={INPUT_CLASS}
        />
      </Field>
    </Section>
  );
}

/**
 * `autoAdvanceSeconds` absent means auto-advance is OFF, not "use some
 * default interval" — a paywall that starts moving on its own without the
 * author asking is a surprise. `NumberField` already treats an emptied
 * input as `undefined`, so clearing the field is enough to turn it off;
 * there is no separate on/off toggle for it. `loop` and `showsIndicator`
 * default from the shared constants when unset, never a hard-coded
 * `true`/`false` in the JSX.
 */
function CarouselContent({ node }: { node: CarouselNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<CarouselNode>) => vm.updateNode<CarouselNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <NumberField
        label={t(
          "paywalls.builder.properties.carouselAutoAdvanceSeconds",
          "Auto-advance (seconds)",
        )}
        value={node.autoAdvanceSeconds}
        onChange={(v) => set({ autoAdvanceSeconds: v })}
      />
      <label className="mt-3 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.loop ?? CAROUSEL_DEFAULT_LOOP}
          onChange={(e) => set({ loop: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.carouselLoop", "Loop")}
      </label>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.showsIndicator ?? CAROUSEL_DEFAULT_SHOWS_INDICATOR}
          onChange={(e) => set({ showsIndicator: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.carouselShowsIndicator", "Shows indicator")}
      </label>
    </Section>
  );
}
