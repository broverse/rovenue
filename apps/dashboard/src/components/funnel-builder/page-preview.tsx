import { Calendar, Check, GitBranch, GripVertical, Mail, Phone, Star, X } from "lucide-react";
import { component, useService } from "impair";
import { useState, type CSSProperties } from "react";
import { PAGE_TYPES, type Page, type Theme } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

function isFilledColor(c?: string): c is string {
  return typeof c === "string" && c.trim().length > 0;
}

type Props = {
  page: Page;
  theme: Theme;
  // When `editable`, choice rows surface hover affordances (drag handle on
  // the left, delete + branch icons on the right) and an "Add choice"
  // button appears below the list. The CanvasEditor turns this on; the
  // play-through PreviewOverlay and ThemeTab live preview leave it off.
  editable?: boolean;
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
export const PagePreview = component(({ page, theme, editable = false }: Props) => {
  const meta = PAGE_TYPES[page.type];
  const bg = page.background;
  const baseColor = isFilledColor(bg?.value) && bg?.kind === "color" ? bg.value : theme.bg;
  const overlayOpacity = bg?.opacity ?? 1;
  const containerStyle: CSSProperties = {
    background: baseColor,
    color: theme.text,
    fontFamily: theme.font || undefined,
  };
  const stepProgress = 4 / 9;
  const hasMediaBg =
    (bg?.kind === "image" || bg?.kind === "video") && isFilledColor(bg?.value);
  // Primary CTA label by page type — `null` means this page type doesn't
  // render a CTA (paywall/welcome use page.cta-with-defaults; success and
  // most question pages fall back to "Continue" / "Open app").
  const ctaLabel: string | null = (() => {
    switch (page.type) {
      case "welcome":
        return page.cta || "Get started";
      case "paywall":
        return "Start free trial";
      case "success":
        return page.cta || "Open app";
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
        return page.cta || "Continue";
      default:
        return null;
    }
  })();
  const footer = page.footer;
  const footerStyle = footer?.enabled
    ? {
        background: footer.bgColor || "transparent",
        borderTop:
          (footer.borderWidth ?? 0) > 0
            ? `${footer.borderWidth}px solid ${footer.borderColor ?? "rgba(0,0,0,0.1)"}`
            : undefined,
      }
    : undefined;
  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden rounded-[28px]"
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
      <div className="flex items-center justify-between px-1 py-1 text-[10px] font-medium opacity-70">
        <span>9:41</span>
        <span>● ● ●</span>
      </div>
      <div
        className="mx-auto mt-2 flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold text-white"
        style={{ background: theme.primary }}
      >
        {theme.logoLetter || "F"}
      </div>
      {page.type !== "paywall" && page.type !== "success" && (
        <div className="mt-3 px-1">
          <div className="h-1 overflow-hidden rounded-full bg-black/10">
            <span
              className="block h-full rounded-full"
              style={{ width: `${stepProgress * 100}%`, background: theme.primary }}
            />
          </div>
          <div className="mt-1.5 text-center text-[10px] opacity-60">Step 4 of 9</div>
        </div>
      )}
      <div className="mt-4 flex flex-1 flex-col gap-2 overflow-hidden">
        {page.mediaKind === "image" && page.mediaUrl && (
          <img
            src={page.mediaUrl}
            alt=""
            className="mb-2 max-h-[180px] w-full rounded-lg object-cover"
          />
        )}
        {page.mediaKind === "video" && page.mediaUrl && (
          <video
            src={page.mediaUrl}
            controls
            playsInline
            className="mb-2 max-h-[180px] w-full rounded-lg bg-black object-cover"
          />
        )}
        <h1 className="m-0 text-[18px] font-semibold leading-tight tracking-tight">
          {page.title || meta.label}
        </h1>
        {page.subtitle && (
          <p className="m-0 text-[12px] leading-relaxed opacity-70">{page.subtitle}</p>
        )}
        {(page.type === "single_choice" || page.type === "multi_choice") &&
          (editable ? (
            <ChoiceListEditable page={page} theme={theme} />
          ) : (
            <ChoiceListReadOnly page={page} theme={theme} />
          ))}
        {page.type === "yes_no" && <YesNoButtons page={page} theme={theme} />}
        {page.type === "picture_choice" && <PictureChoiceList page={page} theme={theme} />}
        {(page.type === "legal" || page.type === "checkbox") && (
          <LegalCheckbox page={page} theme={theme} />
        )}
        {page.type === "opinion_scale" && <OpinionScale page={page} theme={theme} />}
        {page.type === "rating" && <RatingStars page={page} theme={theme} />}
        {page.type === "short_text" && (
          <TextField placeholder={page.placeholder} theme={theme} />
        )}
        {page.type === "long_text" && (
          <TextArea placeholder={page.placeholder} theme={theme} />
        )}
        {page.type === "email" && (
          <TextField
            placeholder={page.placeholder ?? "you@example.com"}
            theme={theme}
            type="email"
            icon={<Mail size={14} />}
          />
        )}
        {page.type === "phone" && (
          <TextField
            placeholder={page.placeholder ?? "+1 555 0000"}
            theme={theme}
            type="tel"
            icon={<Phone size={14} />}
          />
        )}
        {page.type === "text_input" && (
          <TextField placeholder={page.placeholder} theme={theme} />
        )}
        {page.type === "number_input" && <NumberCounter page={page} theme={theme} />}
        {page.type === "date_input" && <DatePicker theme={theme} />}
        {page.type === "slider" && <SliderInput page={page} theme={theme} />}
        {page.type === "contact_info" && <ContactInfoFields page={page} theme={theme} />}
        {page.type === "welcome" && <WelcomeBody page={page} theme={theme} />}
        {page.type === "statement" && <StatementBody page={page} theme={theme} />}
        {page.type === "feature" && <FeatureBody page={page} theme={theme} />}
        {(page.type === "end_screen") && <EndScreenBody page={page} theme={theme} />}
        {page.type === "paywall" && (
          <>
            <h2 className="mt-1 text-[18px] font-semibold leading-tight tracking-tight">
              {page.headline}
            </h2>
            <div className="mt-2 flex flex-col gap-2">
              {(page.benefits || []).map((b) => (
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
              {page.title}
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed opacity-70">{page.body}</p>
          </div>
        )}
      </div>
      </div>
      {/* Footer band — edge-to-edge container that holds the CTA. When
          `footer.enabled` is on, its bg/border style this whole band and
          an optional helper line sits under the button. */}
      {ctaLabel && (
        <div className="px-4 pb-4 pt-3" style={footerStyle}>
          <button
            type="button"
            className="h-10 w-full rounded-lg text-[13px] font-semibold text-white"
            style={{ background: theme.primary }}
          >
            {ctaLabel}
          </button>
          {footer?.enabled && footer.text && (
            <div
              className="mt-2 text-center text-[10px]"
              style={{ color: footer.textColor || theme.text }}
            >
              {footer.text}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
});

// ---------- Choice list ----------

const ChoiceListReadOnly = component(({ page, theme }: { page: Page; theme: Theme }) => {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {(page.options || []).slice(0, 6).map((o, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px]"
          style={{
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
          {o.label}
        </div>
      ))}
    </div>
  );
});

const ChoiceListEditable = component(({ page, theme }: { page: Page; theme: Theme }) => {
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

  // Seed a draft branching rule for this option (question_id eq value) and
  // jump to the Workflow tab so the user can pick the goto target.
  const onBranch = (optionValue: string) => {
    if (!page.question_id) return;
    vm.addRule(page.id, {
      id: Math.random().toString(36).slice(2, 10),
      condition: {
        op: "all",
        clauses: [
          {
            question_id: page.question_id,
            op: "eq",
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
            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px]"
            style={{
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

const YesNoButtons = component(({ page, theme }: { page: Page; theme: Theme }) => {
  const opts = page.options?.length === 2 ? page.options : [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ];
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {opts.map((o) => {
        const active = picked === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setPicked(o.value)}
            className="h-14 rounded-lg text-[14px] font-semibold transition"
            style={{
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
});

// ---------- Number counter ----------

const NumberCounter = component(({ page, theme }: { page: Page; theme: Theme }) => {
  const min = page.min ?? 0;
  const max = page.max ?? 100;
  const step = page.step ?? 1;
  const [n, setN] = useState(min);
  const dec = () => setN((v) => Math.max(min, v - step));
  const inc = () => setN((v) => Math.min(max, v + step));
  return (
    <div className="mt-3 flex items-center justify-center gap-3 rounded-lg px-4 py-3"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}>
      <button
        type="button"
        onClick={dec}
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
        onClick={inc}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] font-bold transition"
        style={{ background: `${theme.primary}15`, color: theme.primary }}
      >
        +
      </button>
    </div>
  );
});

// ---------- Date picker ----------

function DatePicker({ theme }: { theme: Theme }) {
  return (
    <div
      className="mt-3 flex h-10 w-full items-center gap-2 rounded-lg px-3"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}
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

const SliderInput = component(({ page, theme }: { page: Page; theme: Theme }) => {
  const min = page.min ?? 0;
  const max = page.max ?? 100;
  const step = page.step ?? 1;
  const [v, setV] = useState(min + Math.round((max - min) / 2));
  return (
    <div
      className="mt-3 rounded-lg px-4 py-4"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}
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
        onChange={(e) => setV(Number(e.currentTarget.value))}
        className="w-full"
        style={{ accentColor: theme.primary }}
      />
      <div className="mt-1 flex justify-between font-rv-mono text-[10px] opacity-50">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
});

// ---------- Picture choice ----------

const PictureChoiceList = component(({ page, theme }: { page: Page; theme: Theme }) => (
  <div className="mt-2 grid grid-cols-2 gap-2">
    {(page.options ?? []).slice(0, 6).map((o, i) => (
      <div
        key={i}
        className="flex flex-col gap-1 overflow-hidden rounded-lg"
        style={{
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

const LegalCheckbox = component(({ page, theme }: { page: Page; theme: Theme }) => (
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

const OpinionScale = component(({ page, theme }: { page: Page; theme: Theme }) => {
  const min = page.min ?? 1;
  const max = page.max ?? 5;
  const items = [] as number[];
  for (let i = min; i <= max; i++) items.push(i);
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map((n) => (
        <button
          key={n}
          type="button"
          className="flex h-9 min-w-9 items-center justify-center rounded-md text-[13px] font-medium"
          style={{
            border: `1px solid ${theme.primary}`,
            color: theme.primary,
            background: "white",
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
});

// ---------- Rating stars ----------

const RatingStars = component(({ page, theme }: { page: Page; theme: Theme }) => {
  const max = page.max ?? 5;
  // Local interactive preview state — click fills up to that star.
  // Hover lights up the in-flight rating so it feels live in the canvas.
  const [picked, setPicked] = useState(0);
  const [hover, setHover] = useState(0);
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
            onClick={() => setPicked(n)}
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
});

// ---------- Text inputs ----------

function TextField({
  placeholder,
  theme,
  type = "text",
  icon,
}: {
  placeholder?: string;
  theme: Theme;
  type?: "text" | "email" | "tel";
  icon?: React.ReactNode;
}) {
  return (
    <div
      className="mt-3 flex h-10 w-full items-center gap-2 rounded-lg px-3"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}
    >
      {icon && <span style={{ color: theme.primary }}>{icon}</span>}
      <input
        readOnly
        type={type}
        placeholder={placeholder ?? "Type your answer…"}
        className="h-full flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-50"
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
      className="mt-3 w-full resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}
    />
  );
}

// ---------- Contact info ----------

const ContactInfoFields = component(({ page, theme }: { page: Page; theme: Theme }) => (
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

const WelcomeBody = component(({ page, theme }: { page: Page; theme: Theme }) => (
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

const StatementBody = component(({ page }: { page: Page; theme: Theme }) => (
  <div className="flex flex-1 items-center justify-center px-2 text-center">
    <p className="m-0 text-[14px] leading-relaxed opacity-80">
      {page.body || "Statement…"}
    </p>
  </div>
));

const FeatureBody = component(({ page, theme }: { page: Page; theme: Theme }) => (
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

const EndScreenBody = component(({ page, theme }: { page: Page; theme: Theme }) => (
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
