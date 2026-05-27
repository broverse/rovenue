import { Check, GitBranch, GripVertical, X } from "lucide-react";
import { component, useService } from "impair";
import type { CSSProperties } from "react";
import { PAGE_TYPES, type Page, type Theme } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

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
  const style: CSSProperties = {
    background: theme.bg,
    color: theme.text,
  };
  const stepProgress = 4 / 9;
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[28px] px-4 pb-4 pt-2"
      style={style}
    >
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
        {(page.type === "single_choice" ||
          page.type === "multi_choice" ||
          page.type === "yes_no") &&
          (editable ? (
            <ChoiceListEditable page={page} theme={theme} />
          ) : (
            <ChoiceListReadOnly page={page} theme={theme} />
          ))}
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
          <TextField placeholder={page.placeholder ?? "you@example.com"} theme={theme} type="email" />
        )}
        {page.type === "phone" && (
          <TextField placeholder={page.placeholder ?? "+1 555 0000"} theme={theme} type="tel" />
        )}
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
      {(page.type === "single_choice" ||
        page.type === "multi_choice" ||
        page.type === "picture_choice" ||
        page.type === "yes_no" ||
        page.type === "legal" ||
        page.type === "checkbox" ||
        page.type === "opinion_scale" ||
        page.type === "rating" ||
        page.type === "short_text" ||
        page.type === "long_text" ||
        page.type === "email" ||
        page.type === "phone" ||
        page.type === "contact_info" ||
        page.type === "date_input" ||
        page.type === "number_input" ||
        page.type === "slider" ||
        page.type === "text_input" ||
        page.type === "statement" ||
        page.type === "feature") && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          {page.cta || "Continue"}
        </button>
      )}
      {page.type === "welcome" && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          {page.cta || "Get started"}
        </button>
      )}
      {page.type === "paywall" && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          Start free trial
        </button>
      )}
      {page.type === "success" && (
        <button
          type="button"
          className="mt-3 h-10 w-full rounded-lg text-[13px] font-semibold text-white"
          style={{ background: theme.primary }}
        >
          {page.cta || "Open app"}
        </button>
      )}
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
  return (
    <div className="mt-3 flex gap-1.5">
      {Array.from({ length: max }, (_, i) => (
        <Check
          key={i}
          size={28}
          // Using Check as a star stand-in keeps the icon set lean — actual
          // star glyph requires another import.
          style={{ color: i === 0 ? theme.primary : "rgba(0,0,0,0.2)" }}
        />
      ))}
    </div>
  );
});

// ---------- Text inputs ----------

function TextField({
  placeholder,
  theme,
  type = "text",
}: {
  placeholder?: string;
  theme: Theme;
  type?: "text" | "email" | "tel";
}) {
  return (
    <input
      readOnly
      type={type}
      placeholder={placeholder ?? "Type your answer…"}
      className="mt-3 h-10 w-full rounded-lg px-3 text-[13px] outline-none"
      style={{ background: "white", border: `1px solid ${theme.primary}40` }}
    />
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
