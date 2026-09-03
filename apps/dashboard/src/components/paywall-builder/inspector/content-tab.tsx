import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import {
  CAROUSEL_DEFAULT_LOOP,
  CAROUSEL_DEFAULT_SHOWS_INDICATOR,
  COUNTDOWN_DEFAULT_ON_EXPIRY,
  FEATURE_ROW_DEFAULT_INCLUDED,
  FOOTER_LINKS_MAX,
  ICON_NAMES,
  LOTTIE_DEFAULT_AUTOPLAY,
  LOTTIE_DEFAULT_LOOP,
  SOCIAL_PROOF_MAX_RATING,
  VIDEO_DEFAULT_AUTOPLAY,
  VIDEO_DEFAULT_LOOP,
  VIDEO_DEFAULT_MUTED,
  VIDEO_DEFAULT_SHOWS_CONTROLS,
  type ButtonNode,
  type CarouselNode,
  type CountdownNode,
  type DividerNode,
  type FeatureListNode,
  type FeatureRow,
  type FooterLink,
  type FooterLinksNode,
  type IconNode,
  type ImageNode,
  type LottieNode,
  type PaywallNode,
  type PurchaseButtonNode,
  type SocialProofNode,
  type TextNode,
  type TimelineNode,
  type TimelineRow,
  type VideoNode,
} from "@rovenue/shared/paywall";
import { COUNTDOWN_DEFAULT_DURATION_SECONDS } from "../tree-ops";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import {
  ActionField,
  LocalizedTextField,
  NumberField,
  POSITIVE_NUMBER_FIELD_MIN,
  SelectField,
  ThemeUrlField,
} from "./fields";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";
import { RowListEditor } from "./row-list-editor";

/** A featureList/timeline row (or socialProof) has no rating floor below zero. */
const SOCIAL_PROOF_MIN_RATING = 0;
/** The row-icon picker's "let the renderer pick" option — an empty selection,
 *  never a real registry name, so it can't collide with `ICON_NAMES`. */
const ROW_ICON_AUTO_VALUE = "";
/** `schema.ts`'s `footerLinksNodeSchema` declares `links: z.array(...).min(1)`
 *  — unlike featureList/timeline rows, an empty footer link list is not a
 *  valid config. Named here (rather than a bare `1` at the call site) so a
 *  future change to that `.min(...)` has one obvious place in the builder
 *  to update alongside it. */
const FOOTER_LINKS_MIN_LINKS = 1;

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
    case "video":
      return <VideoContent node={node} />;
    case "lottie":
      return <LottieContent node={node} />;
    case "footerLinks":
      return <FooterLinksContent node={node} />;
    // Node types with no Content tab by design: they carry no authorable
    // content of their own. `stack` and `stickyFooter` hold children (their
    // content lives in THEIR children's own Content tabs); `packageList`
    // binds to the offering, which is Binding tab business, not Content;
    // `spacer` has only a size, which is a Layout property.
    case "stack":
    case "stickyFooter":
    case "packageList":
    case "spacer":
      return null;
    default: {
      // A new node type with no decision recorded above fails the build
      // here instead of silently rendering an empty inspector.
      const exhaustive: never = node;
      void exhaustive;
      return null;
    }
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
      <ThemeUrlField
        labelLight={t("paywalls.builder.properties.urlLight", "URL (light)")}
        labelDark={t("paywalls.builder.properties.urlDark", "URL (dark)")}
        // `image.url` is REQUIRED (unlike video's optional `posterUrl`) —
        // collapsing to `undefined` on a fully-cleared field isn't a valid
        // ImageNode, so an emptied field maps back to `{ light: "" }`
        // rather than `undefined` (see ThemeUrlField's own doc comment).
        value={node.url}
        onChange={(v) => set({ url: v ?? { light: "" } })}
        placeholderLight="https://cdn.example.com/photo.png"
        placeholderDark="https://cdn.example.com/photo-dark.png"
        kind="image"
        projectId={vm.projectId}
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

/**
 * `aspectRatio` absent means "the source's own ratio, once known" — NOT a
 * substituted number and not zero. `NumberField` already turns an emptied
 * input into `undefined` rather than `0`, so clearing the field is how an
 * author says "use the source's own"; `POSITIVE_NUMBER_FIELD_MIN` is what
 * stops a typed `0` — the schema declares `aspectRatio` positive, so a zero
 * would make the whole config SCHEMA_INVALID. Every toggle defaults from the
 * shared Task-1 constants, never a hard-coded `true`/`false`.
 */
function VideoContent({ node }: { node: VideoNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<VideoNode>) => vm.updateNode<VideoNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.video", "Video")} defaultOpen>
      <ThemeUrlField
        labelLight={t("paywalls.builder.properties.urlLight", "URL (light)")}
        labelDark={t("paywalls.builder.properties.urlDark", "URL (dark)")}
        // `video.url` is required — see ImageContent's identical note.
        value={node.url}
        onChange={(v) => set({ url: v ?? { light: "" } })}
        placeholderLight="https://cdn.example.com/video.mp4"
        placeholderDark="https://cdn.example.com/video-dark.mp4"
        kind="video"
        projectId={vm.projectId}
      />
      <ThemeUrlField
        className="mt-3"
        labelLight={t("paywalls.builder.properties.videoPosterUrlLight", "Poster URL (light)")}
        labelDark={t("paywalls.builder.properties.videoPosterUrlDark", "Poster URL (dark)")}
        value={node.posterUrl}
        onChange={(v) => set({ posterUrl: v })}
        placeholderLight="https://cdn.example.com/poster.png"
        placeholderDark="https://cdn.example.com/poster-dark.png"
        kind="image"
        projectId={vm.projectId}
      />
      <label className="mt-3 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.autoplay ?? VIDEO_DEFAULT_AUTOPLAY}
          onChange={(e) => set({ autoplay: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.videoAutoplay", "Autoplay")}
      </label>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.loop ?? VIDEO_DEFAULT_LOOP}
          onChange={(e) => set({ loop: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.videoLoop", "Loop")}
      </label>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.muted ?? VIDEO_DEFAULT_MUTED}
          onChange={(e) => set({ muted: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.videoMuted", "Muted")}
      </label>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.showsControls ?? VIDEO_DEFAULT_SHOWS_CONTROLS}
          onChange={(e) => set({ showsControls: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.videoShowsControls", "Shows controls")}
      </label>
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.videoAspectRatio", "Aspect ratio")}
        value={node.aspectRatio}
        onChange={(v) => set({ aspectRatio: v })}
        min={POSITIVE_NUMBER_FIELD_MIN}
      />
    </Section>
  );
}

/**
 * `speed` is intentionally NOT clamped to the advisory band (unlike e.g.
 * SocialProof's rating): the shared validator already raises
 * `LOTTIE_SPEED_OUT_OF_RANGE` as a warning-tier issue when it's outside
 * [`LOTTIE_MIN_SPEED`, `LOTTIE_MAX_SPEED`], so clamping to that band here
 * would make the issue code unreachable from the builder.
 *
 * The SCHEMA floor is a different matter and is enforced: `speed` is
 * `z.number().positive()`, so a typed `0` would not raise the advisory
 * warning at all — it would make the whole config SCHEMA_INVALID, with an
 * error pointing nowhere near this field. `POSITIVE_NUMBER_FIELD_MIN` is
 * deliberately far below `LOTTIE_MIN_SPEED`, so the out-of-range warning
 * stays reachable.
 */
function LottieContent({ node }: { node: LottieNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<LottieNode>) => vm.updateNode<LottieNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.lottie", "Lottie")} defaultOpen>
      <ThemeUrlField
        labelLight={t("paywalls.builder.properties.urlLight", "URL (light)")}
        labelDark={t("paywalls.builder.properties.urlDark", "URL (dark)")}
        // `lottie.url` is required — see ImageContent's identical note.
        value={node.url}
        onChange={(v) => set({ url: v ?? { light: "" } })}
        placeholderLight="https://cdn.example.com/animation.json"
        placeholderDark="https://cdn.example.com/animation-dark.json"
        kind="lottie"
        projectId={vm.projectId}
      />
      <label className="mt-3 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.loop ?? LOTTIE_DEFAULT_LOOP}
          onChange={(e) => set({ loop: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.lottieLoop", "Loop")}
      </label>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={node.autoplay ?? LOTTIE_DEFAULT_AUTOPLAY}
          onChange={(e) => set({ autoplay: e.currentTarget.checked })}
        />
        {t("paywalls.builder.properties.lottieAutoplay", "Autoplay")}
      </label>
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.lottieSpeed", "Speed")}
        value={node.speed}
        onChange={(v) => set({ speed: v })}
        min={POSITIVE_NUMBER_FIELD_MIN}
      />
    </Section>
  );
}

/**
 * Each row's `labelKey` is edited through `LocalizedTextField` (the actual
 * translated TEXT, not a typed-key reference) — unlike `FeatureListContent`/
 * `TimelineContent`'s raw key input, because a footer link's key is always
 * FRESH: `newNode`'s seed link gets `footerLinks_<id>_1`, and `newRow` below
 * mints one in the same shape for every link added afterward
 * (`footerLinks_<id>_<n>`), so there is never a bare key the author needs to
 * type or look up by hand — only its translated copy.
 *
 * The action editor is `ActionField`, the exact widget `ButtonBinding`
 * (binding-tab.tsx) uses for a button's `action` — `FooterLink["action"]`
 * IS `ButtonNode["action"]` (see schema.ts), so this reuses it rather than
 * writing a second copy.
 */
function FooterLinksContent({ node }: { node: FooterLinksNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const setLinks = (links: FooterLink[]) => vm.updateNode<FooterLinksNode>(node.id, { links });

  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <RowListEditor<FooterLink>
        rows={node.links}
        onChange={setLinks}
        maxRows={FOOTER_LINKS_MAX}
        minRows={FOOTER_LINKS_MIN_LINKS}
        newRow={() => ({
          labelKey: `footerLinks_${node.id}_${node.links.length + 1}`,
          action: { kind: "close" },
        })}
        addLabel={t("paywalls.builder.properties.footerLinksAddLink", "Add link")}
        renderRow={(link, _index, patch) => (
          <div className="flex flex-col gap-2">
            <LocalizedTextField
              label={t("paywalls.builder.properties.footerLinksLabel", "Label")}
              locKey={link.labelKey}
            />
            <ActionField value={link.action} onChange={(action) => patch({ action })} />
          </div>
        )}
      />
    </Section>
  );
}
