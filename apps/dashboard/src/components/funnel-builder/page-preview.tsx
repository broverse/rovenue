import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronLeft,
  GitBranch,
  GripVertical,
  Mail,
  Phone,
  Star,
  X,
} from "lucide-react";
import { component, useService } from "impair";
import {
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { PAGE_TYPES, type Page, type ProgressStyle, type Theme } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import type { LocaleCode } from "@rovenue/shared/i18n";
import type { AnswerValue } from "@rovenue/shared/funnel";
import { resolvePage, type ResolvedPage } from "./i18n";

function isFilledColor(c?: string): c is string {
  return typeof c === "string" && c.trim().length > 0;
}

/**
 * Progress indicator used in the page chrome. Pure presentation — picks a
 * variant based on `style`:
 *   - solid: single bar with rounded ends
 *   - rounded: pill-shaped bar with extra height
 *   - segmented: one cell per step (filled up to `currentStep`)
 *   - dashed: dashed track over a thin filled bar
 */
function ProgressIndicator({
  style,
  active,
  inactive,
  progress,
  totalSteps,
  currentStep,
}: {
  style: ProgressStyle;
  active: string;
  inactive: string;
  progress: number;
  totalSteps: number;
  currentStep: number;
}) {
  const pct = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  if (style === "segmented") {
    const cells = Math.max(1, totalSteps);
    return (
      <div className="flex flex-1 items-center gap-[3px]">
        {Array.from({ length: cells }).map((_, i) => (
          <span
            key={i}
            className="block h-[3px] flex-1 rounded-full"
            style={{ background: i < currentStep ? active : inactive }}
          />
        ))}
      </div>
    );
  }
  if (style === "dashed") {
    return (
      <div className="relative flex-1">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            backgroundImage: `repeating-linear-gradient(to right, ${inactive} 0 6px, transparent 6px 10px)`,
            height: 3,
            top: "50%",
            transform: "translateY(-50%)",
          }}
        />
        <div className="relative h-[3px] overflow-hidden rounded-full">
          <span
            className="block h-full rounded-full"
            style={{ width: pct, background: active }}
          />
        </div>
      </div>
    );
  }
  const height = style === "rounded" ? "h-[6px]" : "h-1";
  return (
    <div
      className={`${height} flex-1 overflow-hidden rounded-full`}
      style={{ background: inactive }}
    >
      <span
        className="block h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: pct, background: active }}
      />
    </div>
  );
}

type Props = {
  page: Page;
  theme: Theme;
  // Full pages list — drives the progress indicator. Passed in so this
  // component doesn't depend on the draft VM and can be reused by the
  // public runner (which has no draft).
  pages: Page[];
  locale: LocaleCode;
  defaultLocale: LocaleCode;
  // When `editable`, choice rows surface hover affordances (drag handle on
  // the left, delete + branch icons on the right) and an "Add choice"
  // button appears below the list. The CanvasEditor turns this on; the
  // play-through PreviewOverlay and ThemeTab live preview leave it off.
  editable?: boolean;
  // When provided, the footer CTA becomes a real button that calls this
  // on click. Without it the CTA is inert (builder preview / theme tab).
  onAdvance?: (e: MouseEvent<HTMLButtonElement>) => void;
  // "phone" (default): mobile mockup chrome — rounded corners + fake iOS
  // status bar (9:41). Used by the builder previews.
  // "full": no rounded corners, no status bar. Used by the public runner
  // where the page is the real document, not a mock-up inside a frame.
  chrome?: "phone" | "full";
  // Whether this preview's INPUTS are live.
  //
  // Deliberately an explicit parameter rather than inferred from
  // `onAnswer` being present: the builder canvas's inertness is a
  // requirement, not a side effect of a callback being absent. Inferring
  // it means anyone who later passes `onAnswer` for an unrelated reason
  // silently makes the canvas interactive, and nobody is watching for
  // that. Defaults to "preview" so every existing call site is unchanged.
  mode?: "preview" | "live";
  // The current answer for this page, when `mode` is "live".
  value?: AnswerValue;
  onAnswer?: (value: AnswerValue) => void;
  // Disables the footer CTA. The runner sets it while a `required` page
  // has no answer yet.
  ctaDisabled?: boolean;
};

/**
 * Renders the mobile-screen preview for a single funnel page.
 * Pure presentation when `editable` is false — colors come from `theme`.
 * When `editable`, in-place edit affordances appear on hover.
 *
 * Wrapped with `component(...)` so impair's reactive tracker subscribes
 * to every prop read (page.title, page.options[i].label, theme.primary…)
 * — without this, mutations to those fields via the VM don't trigger a
 * re-render and the preview stays stale.
 */
// Centers + caps the width of an interactive surface (choices, inputs,
// rating, etc.) so it doesn't stretch edge-to-edge on desktop. Text
// content (title / subtitle / body) is intentionally left full-bleed.
function Cap({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-md">{children}</div>;
}

export const PagePreview = component(
  ({
    page,
    theme: rawTheme,
    pages,
    locale,
    defaultLocale,
    editable = false,
    onAdvance,
    chrome = "phone",
    mode = "preview",
    value,
    onAnswer,
    ctaDisabled = false,
  }: Props) => {
  // One gate for every live input below. Reading `mode` — never
  // `onAnswer !== undefined` — is what keeps the builder canvas inert.
  const liveProps = { live: mode === "live", value, onChange: onAnswer };
  // TextField's value is a plain string; the shared AnswerValue union is
  // narrowed here rather than inside the leaf so the leaf stays a dumb
  // controlled input.
  const textLiveProps = {
    live: mode === "live",
    value: typeof value === "string" ? value : "",
    onChange: (next: string) => onAnswer?.(next),
  };
  const resolved: ResolvedPage = useMemo(
    () => resolvePage(page, locale, defaultLocale),
    [page, locale, defaultLocale],
  );
  // Per-page overrides flow through `theme` — sub-components only see the
  // effective value and never need to know whether it came from the page or
  // the global theme.
  const theme: Theme =
    page.radius !== undefined ? { ...rawTheme, radius: page.radius } : rawTheme;
  const meta = PAGE_TYPES[page.type];
  const bg = page.background;
  const baseColor = isFilledColor(bg?.value) && bg?.kind === "color" ? bg.value : theme.bg;
  const overlayOpacity = bg?.opacity ?? 1;
  const containerStyle: CSSProperties = {
    background: baseColor,
    color: theme.text,
    fontFamily: theme.font || undefined,
  };
  const radius = theme.radius;
  const r = (extra?: CSSProperties): CSSProperties => ({ borderRadius: radius, ...extra });
  const hasMediaBg =
    (bg?.kind === "image" || bg?.kind === "video") && isFilledColor(bg?.value);
  // Progress reflects this page's position in the funnel.
  const pageIndex = pages.findIndex((p) => p.id === page.id);
  const totalPages = pages.length;
  const stepNumber = pageIndex >= 0 ? pageIndex + 1 : 1;
  const stepProgress = totalPages > 1 ? Math.min(1, stepNumber / totalPages) : 1;
  const progressActive = isFilledColor(theme.progressActive) ? theme.progressActive : theme.primary;
  const progressInactive = isFilledColor(theme.progressInactive)
    ? theme.progressInactive
    : "rgba(0,0,0,0.1)";
  const BackGlyph = theme.backIcon === "arrow" ? ArrowLeft : ChevronLeft;
  // Primary CTA label by page type — `null` means this page type doesn't
  // render a CTA (paywall/welcome use page.cta-with-defaults; success and
  // most question pages fall back to "Continue" / "Open app").
  const ctaLabel: string | null = (() => {
    switch (page.type) {
      case "welcome":
        return resolved.cta || "Get started";
      case "paywall":
        return "Start free trial";
      case "success":
        return resolved.cta || "Open app";
      case "single_choice":
      case "multi_choice":
      case "picture_choice":
      case "yes_no":
      case "legal":
      case "checkbox":
      case "opinion_scale":
      case "rating":
      case "short_text":
      case "long_text":
      case "email":
      case "phone":
      case "contact_info":
      case "date_input":
      case "number_input":
      case "slider":
      case "text_input":
      case "statement":
      case "feature":
        return resolved.cta || "Continue";
      default:
        return null;
    }
  })();
  const footer = page.footer;
  // Footer is opt-out: undefined and missing-enabled both render as enabled.
  const footerEnabled = footer?.enabled !== false;
  const footerStyle = footerEnabled
    ? {
        background: footer?.bgColor || "transparent",
        borderTop:
          (footer?.borderWidth ?? 0) > 0
            ? `${footer?.borderWidth}px solid ${footer?.borderColor ?? "rgba(0,0,0,0.1)"}`
            : undefined,
      }
    : undefined;
  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden${
        chrome === "phone" ? " rounded-[28px]" : ""
      }`}
      style={containerStyle}
    >
      {/* Full-bleed background layer */}
      {hasMediaBg && bg?.kind === "image" && (
        <img
          src={bg.value}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ opacity: overlayOpacity }}
        />
      )}
      {hasMediaBg && bg?.kind === "video" && (
        <video
          src={bg.value}
          autoPlay
          loop
          muted
          playsInline
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ opacity: overlayOpacity }}
        />
      )}
      {bg?.kind === "color" && bg.opacity < 1 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: theme.bg, opacity: 1 - overlayOpacity }}
        />
      )}
      {/* Content layer — split into scrollable top + footer band that
          contains the primary CTA. The footer's bg/border style the
          wrapper around the button (and any helper text) rather than
          rendering as a separate strip below the button. */}
      <div className="relative z-10 flex h-full w-full flex-col">
      <div className={`flex min-h-0 flex-1 flex-col px-4 pt-2${ctaLabel ? "" : " pb-4"}`}>
      {chrome === "phone" && (
        <div className="flex items-center justify-between px-1 py-1 text-[10px] font-medium opacity-70">
          <span>9:41</span>
          <span>● ● ●</span>
        </div>
      )}
      {(page.showBack || page.showProgress) && (
        <div className="mt-2 flex items-center gap-2">
          {page.showBack ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Back"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full opacity-70 transition hover:opacity-100"
              style={{ color: theme.text }}
            >
              <BackGlyph size={16} strokeWidth={2.2} />
            </button>
          ) : (
            <span className="h-6 w-6 flex-shrink-0" aria-hidden />
          )}
          {page.showProgress ? (
            <ProgressIndicator
              style={theme.progressStyle}
              active={progressActive}
              inactive={progressInactive}
              progress={stepProgress}
              totalSteps={totalPages}
              currentStep={stepNumber}
            />
          ) : (
            <span className="flex-1" />
          )}
        </div>
      )}
      <div className="mt-4 flex flex-1 flex-col gap-2 overflow-hidden">
        {page.mediaKind === "image" && page.mediaUrl && (
          <img
            src={page.mediaUrl}
            alt=""
            className="mb-2 max-h-[180px] w-full object-cover"
            style={r()}
          />
        )}
        {page.mediaKind === "video" && page.mediaUrl && (
          <video
            src={page.mediaUrl}
            controls
            playsInline
            className="mb-2 max-h-[180px] w-full bg-black object-cover"
            style={r()}
          />
        )}
        <h1 className="m-0 text-[18px] font-semibold leading-tight tracking-tight">
          {resolved.title || meta.label}
        </h1>
        {resolved.subtitle && (
          <p className="m-0 text-[12px] leading-relaxed opacity-70">{resolved.subtitle}</p>
        )}
        {(page.type === "single_choice" || page.type === "multi_choice") && (
          <Cap>
            {editable ? (
              <ChoiceListEditable page={resolved} theme={theme} />
            ) : (
              <ChoiceListReadOnly page={resolved} theme={theme} {...liveProps} />
            )}
          </Cap>
        )}
        {page.type === "yes_no" && (
          <Cap>
            <YesNoButtons page={resolved} theme={theme} {...liveProps} />
          </Cap>
        )}
        {page.type === "picture_choice" && (
          <Cap>
            <PictureChoiceList page={resolved} theme={theme} />
          </Cap>
        )}
        {(page.type === "legal" || page.type === "checkbox") && (
          <Cap>
            <LegalCheckbox page={resolved} theme={theme} />
          </Cap>
        )}
        {page.type === "opinion_scale" && (
          <Cap>
            <OpinionScale page={resolved} theme={theme} {...liveProps} />
          </Cap>
        )}
        {page.type === "rating" && (
          <Cap>
            <RatingStars page={resolved} theme={theme} {...liveProps} />
          </Cap>
        )}
        {page.type === "short_text" && (
          <Cap>
            <TextField placeholder={resolved.placeholder} theme={theme} {...textLiveProps} />
          </Cap>
        )}
        {page.type === "long_text" && (
          <Cap>
            <TextArea placeholder={resolved.placeholder} theme={theme} />
          </Cap>
        )}
        {page.type === "email" && (
          <Cap>
            <TextField
              placeholder={resolved.placeholder ?? "you@example.com"}
              theme={theme}
              type="email"
              icon={<Mail size={14} />}
              {...textLiveProps}
            />
          </Cap>
        )}
        {page.type === "phone" && (
          <Cap>
            <TextField
              placeholder={resolved.placeholder ?? "+1 555 0000"}
              theme={theme}
              type="tel"
              icon={<Phone size={14} />}
            />
          </Cap>
        )}
        {page.type === "text_input" && (
          <Cap>
            <TextField placeholder={resolved.placeholder} theme={theme} {...textLiveProps} />
          </Cap>
        )}
        {page.type === "number_input" && (
          <Cap>
            <NumberCounter page={resolved} theme={theme} {...liveProps} />
          </Cap>
        )}
        {page.type === "date_input" && (
          <Cap>
            <DatePicker theme={theme} />
          </Cap>
        )}
        {page.type === "slider" && (
          <Cap>
            <SliderInput page={resolved} theme={theme} {...liveProps} />
          </Cap>
        )}
        {page.type === "contact_info" && (
          <Cap>
            <ContactInfoFields page={resolved} theme={theme} />
          </Cap>
        )}
        {page.type === "welcome" && <WelcomeBody page={resolved} theme={theme} />}
        {page.type === "statement" && <StatementBody page={resolved} theme={theme} />}
        {page.type === "feature" && <FeatureBody page={resolved} theme={theme} />}
        {(page.type === "end_screen") && <EndScreenBody page={resolved} theme={theme} />}
        {page.type === "paywall" && (
          <>
            <h2 className="mt-1 text-[18px] font-semibold leading-tight tracking-tight">
              {resolved.headline}
            </h2>
            <div className="mt-2 flex flex-col gap-2">
              {(resolved.benefits || []).map((b) => (
                <div key={b} className="flex items-center gap-2 text-[12px]">
                  <span
                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-white"
                    style={{ background: theme.primary }}
                  >
                    <Check size={10} />
                  </span>
                  {b}
                </div>
              ))}
            </div>
          </>
        )}
        {page.type === "success" && (
          <div className="flex flex-col items-center px-2 py-4 text-center">
            <div
              className="mb-3 flex h-14 w-14 items-center justify-center rounded-full"
              style={{
                background: `color-mix(in srgb, ${theme.primary} 18%, transparent)`,
                color: theme.primary,
              }}
            >
              <Check size={28} />
            </div>
            <h2 className="m-0 text-[18px] font-semibold leading-tight tracking-tight">
              {resolved.title}
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed opacity-70">{resolved.body}</p>
          </div>
        )}
      </div>
      </div>
      {/* Footer band — edge-to-edge container that holds the CTA.
          Defaults to enabled (`footer.enabled !== false`); the bg / border
          fields style this whole band when the user customises them. */}
      {ctaLabel && footerEnabled && (
        <div className="px-4 pb-4 pt-3" style={footerStyle}>
          <button
            type="button"
            onClick={onAdvance}
            disabled={ctaDisabled}
            className={`mx-auto block h-10 w-full max-w-md text-[13px] font-semibold text-white${
              onAdvance && !ctaDisabled ? " cursor-pointer transition active:scale-[0.98]" : ""
            }${ctaDisabled ? " cursor-not-allowed opacity-50" : ""}`}
            style={r({ background: footer?.buttonColor || theme.primary })}
          >
            {ctaLabel}
          </button>
        </div>
      )}
      </div>
    </div>
  );
});

// ---------- Choice list ----------

const ChoiceListReadOnly = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    // Passed explicitly, never inferred from `onChange` being present.
    // Inferring it reproduces one level down the very anti-pattern the
    // `mode` prop exists to prevent: a live page with no handler would
    // silently render as a PREVIEW and highlight row 0, showing the
    // visitor an answer they never gave.
    live?: boolean;
    // `value` is a single option value for single_choice and an array for
    // multi_choice.
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const multi = page.type === "multi_choice";
    const selected: string[] = multi
      ? Array.isArray(value)
        ? value
        : []
      : typeof value === "string"
        ? [value]
        : [];

    // In preview mode the first row is highlighted as a static sample of
    // what a selection looks like. In live mode nothing is highlighted
    // until the visitor picks — a pre-highlighted row would read as an
    // answer they did not give.
    const isActive = (o: { value: string }, i: number) =>
      live ? selected.includes(o.value) : i === 0;

    const pick = (optionValue: string) => {
      if (!onChange) return;
      if (!multi) {
        onChange(optionValue);
        return;
      }
      // Toggle: add when absent, remove when present, and leave the order
      // of everything else alone.
      onChange(
        selected.includes(optionValue)
          ? selected.filter((v) => v !== optionValue)
          : [...selected, optionValue],
      );
    };

    return (
      <div className="mt-2 flex flex-col gap-2">
        {/* The cap is a mock-up aesthetic — six rows is what fits the
            phone frame. In live mode it would silently hide a 7th choice
            from a visitor who could then never answer it, so the real page
            shows every option. */}
        {(live ? page.options || [] : (page.options || []).slice(0, 6)).map((o, i) => {
          const active = isActive(o, i);
          const row = (
            <>
              <span
                className="block flex-shrink-0"
                style={{
                  width: 14,
                  height: 14,
                  border: `1.5px solid ${theme.primary}`,
                  borderRadius: multi ? 3 : "50%",
                  background: active ? theme.primary : "transparent",
                }}
              />
              {o.label}
            </>
          );
          const style = {
            borderRadius: theme.radius,
            background: "white",
            border: `1px solid ${active ? theme.primary : "rgba(0,0,0,0.08)"}`,
            boxShadow: active ? `0 0 0 2px ${theme.primary}25` : undefined,
          };
          const className = "flex items-center gap-2 px-3 py-2.5 text-[12px]";

          return live ? (
            <button key={i} type="button" onClick={() => pick(o.value)} className={className} style={style}>
              {row}
            </button>
          ) : (
            <div key={i} className={className} style={style}>
              {row}
            </div>
          );
        })}
      </div>
    );
  },
);

const ChoiceListEditable = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => {
  const vm = useService(FunnelDraftViewModel);
  const options = page.options ?? [];

  // HTML5 drag-and-drop reordering. dataTransfer carries the source index;
  // dragover preventDefault is required for drop to fire.
  const onDragStart = (e: React.DragEvent, i: number) => {
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: React.DragEvent, to: number) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isFinite(from) && from !== to) {
      vm.reorderOption(page.id, from, to);
    }
  };

  // Seed a draft branching rule for this option and jump to the Workflow
  // tab so the user can pick the goto target.
  //
  // The operator depends on the page type, and getting it wrong is silent.
  // A multi_choice answer is a string[]; `eq` compares with `===`, so
  // `["a"] === "a"` is false and the rule could NEVER fire. `contains` is
  // the only positive operator in the evaluator that handles an array
  // (see evalClause). Seeding `eq` here handed the author a rule that
  // looked right, was written for them in one click, and silently never
  // matched.
  const onBranch = (optionValue: string) => {
    if (!page.question_id) return;
    const op = page.type === "multi_choice" ? "contains" : "eq";
    vm.addRule(page.id, {
      id: Math.random().toString(36).slice(2, 10),
      condition: {
        op: "all",
        clauses: [
          {
            question_id: page.question_id,
            op,
            value: optionValue,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
      },
      goto: "end",
    });
    vm.setActiveTab("workflow");
  };

  // The "outer container" hover affordance — drag handle on the left,
  // delete + branch on the right, both rendered OUTSIDE the option card
  // so they don't crowd the runtime preview. The last surviving option
  // can't be deleted (a choice page with zero options is meaningless).
  const canDelete = options.length > 1;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {options.map((o, i) => (
        <div
          key={i}
          onDragOver={onDragOver}
          onDrop={(e) => onDrop(e, i)}
          className="group relative"
        >
          {/* Drag handle — sits outside the card on the left */}
          <button
            type="button"
            draggable
            onDragStart={(e) => onDragStart(e, i)}
            title="Drag to reorder"
            className="absolute -left-10 top-1/2 hidden h-7 w-7 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border bg-white text-rv-mute-700 transition group-hover:flex hover:scale-110 active:cursor-grabbing"
            style={{ borderColor: "rgba(0,0,0,0.12)" }}
          >
            <GripVertical size={14} />
          </button>

          {/* Option card */}
          <div
            className="flex items-center gap-2 px-3 py-2.5 text-[12px]"
            style={{
              borderRadius: theme.radius,
              background: "white",
              border: `1px solid ${i === 0 ? theme.primary : "rgba(0,0,0,0.08)"}`,
              boxShadow: i === 0 ? `0 0 0 2px ${theme.primary}25` : undefined,
            }}
          >
            <span
              className="block flex-shrink-0"
              style={{
                width: 14,
                height: 14,
                border: `1.5px solid ${theme.primary}`,
                borderRadius: page.type === "multi_choice" ? 3 : "50%",
                background: i === 0 ? theme.primary : "transparent",
              }}
            />
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
          </div>

          {/* Hover actions — sit outside the card on the right */}
          <div className="absolute -right-20 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
            <button
              type="button"
              onClick={() => canDelete && vm.removeOption(page.id, i)}
              disabled={!canDelete}
              title={canDelete ? "Delete option" : "At least one option required"}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border bg-white text-rv-danger transition hover:scale-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
              style={{ borderColor: "rgba(0,0,0,0.12)" }}
            >
              <X size={13} />
            </button>
            {page.question_id && (
              <button
                type="button"
                onClick={() => onBranch(o.value)}
                title="Branch from this option"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border bg-white text-rv-mute-700 transition hover:scale-110"
                style={{ borderColor: "rgba(0,0,0,0.12)" }}
              >
                <GitBranch size={13} />
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => vm.addOption(page.id)}
        className="mt-1 self-start text-[12px] font-medium"
        style={{ color: theme.primary }}
      >
        + Add choice
      </button>
    </div>
  );
});

// ---------- Yes / No ----------

const YesNoButtons = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    // Passed explicitly, never inferred — see ChoiceListReadOnly.
    live?: boolean;
    // Supplied only in live mode. The recorded answer is the option's
    // VALUE STRING, exactly like single_choice.
    //
    // It was a boolean at first, on the reasoning that "yes"/"no" is
    // presentation. That was wrong, because it ignored the other side of
    // the comparison: rule-editor.tsx writes a clause operand from a
    // free-text input, so it is always a string, and evalClause's `eq` is
    // strict equality. `true === "yes"` is false, so every yes/no
    // branching rule would silently never match.
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
  const opts = page.options?.length === 2 ? page.options : [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ];
  const [picked, setPicked] = useState<string | null>(null);
  const activeValue = live ? (typeof value === "string" ? value : null) : picked;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {opts.map((o) => {
        const active = activeValue === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => (live && onChange ? onChange(o.value) : setPicked(o.value))}
            className="h-14 text-[14px] font-semibold transition"
            style={{
              borderRadius: theme.radius,
              background: active ? theme.primary : "white",
              color: active ? "white" : theme.text,
              border: `1px solid ${theme.primary}${active ? "" : "40"}`,
              boxShadow: active ? `0 0 0 2px ${theme.primary}25` : undefined,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
  },
);

// ---------- Number counter ----------

const NumberCounter = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 0;
    const max = page.max ?? 100;
    const step = page.step ?? 1;
    const [local, setLocal] = useState(min);
    // Live mode shows the recorded answer; before the visitor interacts
    // there is none, so it rests at `min` FOR DISPLAY ONLY — that resting
    // value is never sent.
    const n = live ? (typeof value === "number" ? value : min) : local;
    const commit = (next: number) => {
      const clamped = Math.max(min, Math.min(max, next));
      if (live) onChange?.(clamped);
      else setLocal(clamped);
    };
    return (
      <div className="mt-3 flex items-center justify-center gap-3 px-4 py-3"
        style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}>
        <button
          type="button"
          aria-label="decrement"
          onClick={() => commit(n - step)}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] font-bold transition"
          style={{ background: `${theme.primary}15`, color: theme.primary }}
        >
          −
        </button>
        <div className="min-w-[60px] text-center font-rv-mono text-[28px] font-bold tabular-nums">
          {n}
          {page.suffix && (
            <span className="ml-1 text-[14px] font-normal opacity-60">{page.suffix}</span>
          )}
        </div>
        <button
          type="button"
          aria-label="increment"
          onClick={() => commit(n + step)}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] font-bold transition"
          style={{ background: `${theme.primary}15`, color: theme.primary }}
        >
          +
        </button>
      </div>
    );
  },
);

// ---------- Date picker ----------

function DatePicker({ theme }: { theme: Theme }) {
  return (
    <div
      className="mt-3 flex h-10 w-full items-center gap-2 px-3"
      style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
    >
      <Calendar size={14} style={{ color: theme.primary }} />
      <input
        readOnly
        type="date"
        className="h-full flex-1 bg-transparent text-[13px] outline-none"
      />
    </div>
  );
}

// ---------- Slider ----------

const SliderInput = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 0;
    const max = page.max ?? 100;
    const step = page.step ?? 1;
    const rest = min + Math.round((max - min) / 2);
    const [local, setLocal] = useState(rest);
    const v = live ? (typeof value === "number" ? value : rest) : local;
    const onRange = (e: ChangeEvent<HTMLInputElement>) => {
      const next = Number(e.currentTarget.value);
      if (live) onChange?.(next);
      else setLocal(next);
    };
    return (
      <div
        className="mt-3 px-4 py-4"
        style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
      >
        <div className="mb-2 text-center font-rv-mono text-[24px] font-bold tabular-nums">
          {v}
          {page.suffix && (
            <span className="ml-1 text-[12px] font-normal opacity-60">{page.suffix}</span>
          )}
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          onChange={onRange}
          className="w-full"
          style={{ accentColor: theme.primary }}
        />
        <div className="mt-1 flex justify-between font-rv-mono text-[10px] opacity-50">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>
    );
  },
);

// ---------- Picture choice ----------

const PictureChoiceList = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <div className="mt-2 grid grid-cols-2 gap-2">
    {(page.options ?? []).slice(0, 6).map((o, i) => (
      <div
        key={i}
        className="flex flex-col gap-1 overflow-hidden"
        style={{
          borderRadius: theme.radius,
          background: "white",
          border: `1px solid ${i === 0 ? theme.primary : "rgba(0,0,0,0.08)"}`,
          boxShadow: i === 0 ? `0 0 0 2px ${theme.primary}25` : undefined,
        }}
      >
        <div
          className="flex aspect-square w-full items-center justify-center text-[10px] opacity-50"
          style={{ background: "rgba(0,0,0,0.04)" }}
        >
          {o.imageUrl ? (
            <img src={o.imageUrl} alt={o.label} className="h-full w-full object-cover" />
          ) : (
            "no image"
          )}
        </div>
        <div className="px-2 py-1.5 text-[11px]">{o.label}</div>
      </div>
    ))}
  </div>
));

// ---------- Legal / checkbox ----------

const LegalCheckbox = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px]">
    <span
      className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded"
      style={{ border: `1.5px solid ${theme.primary}`, background: "transparent" }}
    />
    <span className="leading-snug">
      {page.agreementLabel || "I agree"}
      {page.termsUrl && (
        <a className="ml-1 underline" style={{ color: theme.primary }} href={page.termsUrl}>
          Read terms
        </a>
      )}
    </span>
  </label>
));

// ---------- Opinion scale 1-5 ----------

const OpinionScale = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 1;
    const max = page.max ?? 5;
    const items = [] as number[];
    for (let i = min; i <= max; i++) items.push(i);
    const selected = live && typeof value === "number" ? value : null;
    return (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {items.map((n) => {
          const on = selected === n;
          return (
            <button
              key={n}
              type="button"
              onClick={live ? () => onChange?.(n) : undefined}
              className="flex h-9 min-w-9 items-center justify-center rounded-md text-[13px] font-medium"
              style={{
                border: `1px solid ${theme.primary}`,
                color: on ? "white" : theme.primary,
                background: on ? theme.primary : "white",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
    );
  },
);

// ---------- Rating stars ----------

const RatingStars = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const max = page.max ?? 5;
    const [localPicked, setLocalPicked] = useState(0);
    const [hover, setHover] = useState(0);
    // The recorded rating in live mode; the local preview pick otherwise.
    const picked = live ? (typeof value === "number" ? value : 0) : localPicked;
    const filledThrough = hover || picked;
    return (
      <div className="mt-3 flex items-center gap-1.5" onMouseLeave={() => setHover(0)}>
        {Array.from({ length: max }, (_, i) => {
          const n = i + 1;
          const on = n <= filledThrough;
          return (
            <button
              key={i}
              type="button"
              aria-label={`rate ${n}`}
              onClick={() => (live ? onChange?.(n) : setLocalPicked(n))}
              onMouseEnter={() => setHover(n)}
              className="cursor-pointer p-0.5 transition hover:scale-110"
            >
              <Star
                size={30}
                strokeWidth={1.5}
                style={{
                  color: theme.primary,
                  fill: on ? theme.primary : "transparent",
                }}
              />
            </button>
          );
        })}
        {picked > 0 && (
          <span className="ml-2 font-rv-mono text-[11px] opacity-60">
            {picked} / {max}
          </span>
        )}
      </div>
    );
  },
);

// ---------- Text inputs ----------

function TextField({
  placeholder,
  theme,
  type = "text",
  icon,
  live = false,
  value,
  onChange,
}: {
  placeholder?: string;
  theme: Theme;
  type?: "text" | "email" | "tel";
  icon?: React.ReactNode;
  // Passed explicitly, never inferred — see ChoiceListReadOnly.
  live?: boolean;
  value?: string;
  onChange?: (next: string) => void;
}) {
  return (
    <div
      className="mt-3 flex h-10 w-full items-center gap-2 px-3"
      style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
    >
      {icon && <span style={{ color: theme.primary }}>{icon}</span>}
      <input
        readOnly={!live}
        type={type}
        placeholder={placeholder ?? "Type your answer…"}
        className="h-full flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-50"
        {...(live && onChange
          ? { value: value ?? "", onChange: (e) => onChange(e.currentTarget.value) }
          : {})}
      />
    </div>
  );
}

function TextArea({ placeholder, theme }: { placeholder?: string; theme: Theme }) {
  return (
    <textarea
      readOnly
      rows={3}
      placeholder={placeholder ?? "Type your answer…"}
      className="mt-3 w-full resize-none px-3 py-2 text-[13px] outline-none"
      style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
    />
  );
}

// ---------- Contact info ----------

const ContactInfoFields = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <div className="mt-3 flex flex-col gap-2">
    {page.collectName !== false && (
      <TextField placeholder="Full name" theme={theme} />
    )}
    {page.collectEmail !== false && (
      <TextField placeholder="you@example.com" theme={theme} type="email" />
    )}
    {page.collectPhone && <TextField placeholder="+1 555 0000" theme={theme} type="tel" />}
  </div>
));

// ---------- Welcome / Statement / Feature / End ----------

const WelcomeBody = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
    <div
      className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-[24px] font-bold text-white"
      style={{ background: theme.primary }}
    >
      {theme.logoLetter || "F"}
    </div>
    <h2 className="m-0 text-[20px] font-semibold leading-tight">{page.title || "Welcome"}</h2>
    {page.body && (
      <p className="mt-2 text-[13px] leading-relaxed opacity-70">{page.body}</p>
    )}
  </div>
));

const StatementBody = component(({ page }: { page: ResolvedPage; theme: Theme }) => (
  <div className="flex flex-1 items-center justify-center px-2 text-center">
    <p className="m-0 text-[14px] leading-relaxed opacity-80">
      {page.body || "Statement…"}
    </p>
  </div>
));

const FeatureBody = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <div className="mt-1 flex flex-col gap-3">
    {page.headline && (
      <h2 className="m-0 text-[18px] font-semibold leading-tight">{page.headline}</h2>
    )}
    <div className="flex flex-col gap-2">
      {(page.features ?? []).map((f, i) => (
        <div key={i} className="flex items-start gap-2 text-[12px]">
          <span
            className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-white"
            style={{ background: theme.primary }}
          >
            <Check size={10} />
          </span>
          {f}
        </div>
      ))}
    </div>
  </div>
));

const EndScreenBody = component(({ page, theme }: { page: ResolvedPage; theme: Theme }) => (
  <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
    <div
      className="mb-3 flex h-14 w-14 items-center justify-center rounded-full"
      style={{
        background: `color-mix(in srgb, ${theme.primary} 18%, transparent)`,
        color: theme.primary,
      }}
    >
      <Check size={28} />
    </div>
    <h2 className="m-0 text-[20px] font-semibold leading-tight">{page.title || "Thanks!"}</h2>
    {page.body && (
      <p className="mt-2 text-[13px] leading-relaxed opacity-70">{page.body}</p>
    )}
  </div>
));
