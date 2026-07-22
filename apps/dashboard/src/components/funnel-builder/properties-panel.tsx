import { useState } from "react";
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  Code,
  Image as ImageIcon,
  Play,
  Plus,
  Type as TypeIcon,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { rpc, unwrap } from "../../lib/api";
import { LocalizedInput, LocalizedTextarea, LocalizedArrayInput } from "./localized-input";
import type { LocaleCode } from "@rovenue/shared/i18n";
import {
  PAGE_GROUPS,
  PAGE_TYPE_DESC,
  PAGE_TYPES,
  type BackIcon,
  type Page,
  type PageType,
  type ProgressStyle,
} from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { RuleEditor } from "./rule-editor";
import { ColorSwatchInput } from "./color-swatch-input";
import { useProjectPaywalls } from "../../lib/hooks/useProjectPaywalls";

const PROGRESS_STYLES: ReadonlyArray<{ value: ProgressStyle; label: string }> = [
  { value: "solid", label: "Solid" },
  { value: "rounded", label: "Rounded" },
  { value: "segmented", label: "Segmented" },
  { value: "dashed", label: "Dashed" },
];

const BACK_ICONS: ReadonlyArray<{ value: BackIcon; label: string; icon: typeof ChevronLeft }> = [
  { value: "chevron", label: "Chevron", icon: ChevronLeft },
  { value: "arrow", label: "Arrow", icon: ArrowLeft },
];

interface ProductDto {
  id: string;
  identifier: string;
  displayName: string;
}

function useProjectProducts(projectId: string | undefined) {
  return useQuery({
    queryKey: ["funnel-builder-products", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ products: ProductDto[]; nextCursor: string | null }>(
        rpc.dashboard.projects[":projectId"].products.$get({
          param: { projectId: projectId! },
          query: {},
        }),
      ),
    select: (r) => r.products,
  });
}

interface PropertiesPanelProps {
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
}

export const PropertiesPanel = component(({ editLocale, defaultLocale }: PropertiesPanelProps) => {
  // Hooks must run unconditionally on every render — keep them above any
  // `return null`. React throws "Should have a queue" otherwise when the
  // selected page flips from undefined to set between renders.
  const vm = useService(FunnelDraftViewModel);
  const { data: products = [] } = useProjectProducts(vm.projectId);
  const { data: paywallsData } = useProjectPaywalls(vm.projectId);
  // Only paywalls with a builderConfig can render via <PaywallRenderer> —
  // the publish gate rejects a paywallId reference otherwise, so hide
  // the ones that can't actually be picked.
  const builderPaywalls = (paywallsData?.paywalls ?? []).filter(
    (pw) => pw.builderConfig != null,
  );

  const page = vm.selectedPage;
  if (!page) {
    return (
      <aside className="flex flex-1 flex-col items-center justify-center border-l border-rv-divider bg-rv-bg px-6 text-center">
        <div className="rounded-lg border border-dashed border-rv-divider bg-rv-c2 px-4 py-6">
          <div className="text-[13px] font-medium text-foreground">No page selected</div>
          <div className="mt-1 text-[11px] text-rv-mute-500">
            Add or pick a page from the rail on the left to edit its content here.
          </div>
        </div>
      </aside>
    );
  }
  const meta = PAGE_TYPES[page.type];
  const rules = vm.rules[page.id] ?? [];
  const sourceIndex = vm.pages.findIndex((p) => p.id === page.id);
  const earlierQs = vm.pages
    .slice(0, sourceIndex)
    .map((p) => p.question_id)
    .filter((q): q is string => Boolean(q));

  const isQuestionPage = !!page.question_id;
  const headerLabel = isQuestionPage ? "Question" : meta.label;

  const set = (patch: Partial<Page>) => vm.updatePage(page.id, patch);

  // Page types that render a footer button in the preview. Mirror the
  // ctaLabel switch in page-preview.tsx — keep these in sync.
  const NO_CTA_TYPES: ReadonlyArray<Page["type"]> = ["info", "loading", "result", "end_screen"];
  const hasCta = !NO_CTA_TYPES.includes(page.type);
  // Paywall's CTA label is locked ("Start free trial"); everything else
  // reads `page.cta` with a per-type fallback.
  const ctaEditable = hasCta && page.type !== "paywall";
  const ctaPlaceholder =
    page.type === "welcome" ? "Get started" : page.type === "success" ? "Open app" : "Continue";

  return (
    <aside className="flex w-[340px] flex-shrink-0 flex-col border-l border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
        <h3 className="m-0 text-[13px] font-semibold">{headerLabel}</h3>
        <button
          type="button"
          title="Page comments"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
        >
          <Code size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Media tabs — switching to Image/Video reveals a URL input
            and the chosen media renders above the title in the preview. */}
        <Section>
          <Segmented
            value={page.mediaKind ?? "none"}
            onChange={(v) => {
              set({ mediaKind: v === "none" ? "none" : v });
              if (v === "none") set({ mediaUrl: "" });
            }}
            options={[
              { value: "none", label: "Text", icon: <TypeIcon size={12} /> },
              { value: "image", label: "Image", icon: <ImageIcon size={12} /> },
              { value: "video", label: "Video", icon: <Play size={12} /> },
            ]}
          />
          {(page.mediaKind === "image" || page.mediaKind === "video") && (
            <Field label="Media URL" className="mt-3">
              <input
                value={page.mediaUrl ?? ""}
                onChange={(e) => set({ mediaUrl: e.currentTarget.value })}
                placeholder={
                  page.mediaKind === "image"
                    ? "https://cdn.example.com/photo.jpg"
                    : "https://cdn.example.com/clip.mp4"
                }
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}
        </Section>

        <Section title={isQuestionPage ? "Answer type" : "Page type"}>
          <AnswerTypeDropdown
            value={page.type}
            onChange={(t) => set({ type: t })}
          />
        </Section>

        {/* Content editing — replaces the inline canvas inputs. Every page
            type surfaces the fields the preview renders, so the canvas
            stays read-only and the sidebar is the single edit surface. */}
        <Section title="Content">
          {page.type !== "paywall" && page.type !== "success" && (
            <>
              <Field label="Title" className="mb-3">
                <LocalizedInput
                  value={page.title}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ title: next })}
                  placeholder="Your question or screen title"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              {page.type !== "loading" && page.type !== "result" && (
                <Field label="Subtitle" className="mb-3">
                  <LocalizedInput
                    value={page.subtitle}
                    editLocale={editLocale}
                    defaultLocale={defaultLocale}
                    onChange={(next) => set({ subtitle: next })}
                    placeholder="Optional helper text"
                    className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </Field>
              )}
            </>
          )}

          {(page.type === "single_choice" || page.type === "multi_choice") && (
            <Field label={`Options · ${(page.options ?? []).length}`}>
              <div className="flex flex-col gap-1.5">
                {(page.options ?? []).map((o, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-1.5 py-1"
                  >
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-rv-c3 font-rv-mono text-[10px] font-bold text-rv-mute-600">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <LocalizedInput
                      value={o.label}
                      editLocale={editLocale}
                      defaultLocale={defaultLocale}
                      onChange={(next) => {
                        const opts = [...(page.options ?? [])];
                        opts[i] = { ...opts[i], label: next };
                        set({ options: opts });
                      }}
                      placeholder="Label"
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none"
                    />
                    <input
                      value={o.value}
                      onChange={(e) => vm.updateOption(page.id, i, { value: e.currentTarget.value })}
                      placeholder="value"
                      className="w-20 rounded border border-rv-divider bg-rv-c1 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-700 outline-none focus:border-rv-accent-500"
                    />
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => vm.removeOption(page.id, i)}
                      className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => vm.addOption(page.id)}
                  className="mt-1 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
                >
                  <Plus size={11} />
                  Add option
                </button>
              </div>
            </Field>
          )}

          {page.type === "info" && (
            <Field label="Body · markdown">
              <LocalizedTextarea
                value={page.body}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ body: next })}
                rows={4}
                placeholder="Hello, world."
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {page.type === "result" && (
            <Field label="Body">
              <LocalizedTextarea
                value={page.body}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ body: next })}
                rows={3}
                placeholder="Supports {{question_id}} tokens"
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {page.type === "paywall" && (
            <>
              <Field label="Headline" className="mb-3">
                <LocalizedInput
                  value={page.headline}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ headline: next })}
                  placeholder="Unlock your plan"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="Benefits">
                <LocalizedArrayInput
                  value={page.benefits}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ benefits: next })}
                  placeholder="Benefit line"
                />
              </Field>
            </>
          )}

          {page.type === "success" && (
            <>
              <Field label="Headline" className="mb-3">
                <LocalizedInput
                  value={page.title}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ title: next })}
                  placeholder="You're in"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="Body">
                <LocalizedInput
                  value={page.body}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ body: next })}
                  placeholder="What happens next"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            </>
          )}

          {page.type === "loading" && (
            <Field label="Steps">
              <LocalizedArrayInput
                value={page.steps}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ steps: next })}
                placeholder="Step text"
              />
            </Field>
          )}

          {/* Inputs that take a placeholder */}
          {(page.type === "short_text" ||
            page.type === "long_text" ||
            page.type === "email" ||
            page.type === "phone" ||
            page.type === "text_input") && (
            <Field label="Placeholder">
              <LocalizedInput
                value={page.placeholder}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ placeholder: next })}
                placeholder="Type your answer…"
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {/* Contact info — which sub-fields the form collects */}
          {page.type === "contact_info" && (
            <Field label="Collect">
              <div className="flex flex-col gap-1">
                {[
                  ["Name", "collectName"],
                  ["Email", "collectEmail"],
                  ["Phone", "collectPhone"],
                ].map(([label, key]) => {
                  const k = key as "collectName" | "collectEmail" | "collectPhone";
                  return (
                    <Toggle
                      key={k}
                      on={!!page[k]}
                      label={label as string}
                      onChange={(v) => set({ [k]: v } as Partial<Page>)}
                    />
                  );
                })}
              </div>
            </Field>
          )}

          {/* Legal / checkbox — agreement copy + optional link */}
          {(page.type === "legal" || page.type === "checkbox") && (
            <>
              <Field label="Agreement label" className="mb-3">
                <LocalizedInput
                  value={page.agreementLabel}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ agreementLabel: next })}
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              {page.type === "legal" && (
                <Field label="Terms URL">
                  <input
                    value={page.termsUrl ?? ""}
                    onChange={(e) => set({ termsUrl: e.currentTarget.value })}
                    placeholder="https://…/terms"
                    className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </Field>
              )}
            </>
          )}

          {/* Opinion scale — min/max */}
          {page.type === "opinion_scale" && (
            <Field label="Range">
              <div className="grid grid-cols-2 gap-2">
                <MonoInput value={page.min} onChange={(v) => set({ min: v })} />
                <MonoInput value={page.max} onChange={(v) => set({ max: v })} />
              </div>
            </Field>
          )}

          {/* Welcome / End screen — body + CTA */}
          {(page.type === "welcome" || page.type === "end_screen") && (
            <>
              <Field label="Body" className="mb-3">
                <LocalizedTextarea
                  value={page.body}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ body: next })}
                  rows={3}
                  className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            </>
          )}

          {/* Statement — body only; the CTA label lives in the Footer section. */}
          {page.type === "statement" && (
            <Field label="Body">
              <LocalizedTextarea
                value={page.body}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ body: next })}
                rows={3}
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {/* Feature screen — headline + bulleted feature lines + CTA */}
          {page.type === "feature" && (
            <>
              <Field label="Headline" className="mb-3">
                <LocalizedInput
                  value={page.headline}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ headline: next })}
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="Features" className="mb-3">
                <LocalizedArrayInput
                  value={page.features}
                  editLocale={editLocale}
                  defaultLocale={defaultLocale}
                  onChange={(next) => set({ features: next })}
                  placeholder="Feature line"
                />
              </Field>
            </>
          )}
        </Section>

        {(page.type === "single_choice" || page.type === "multi_choice") && (
          <Section title="Behavior">
            <Toggle
              on={!!page.required}
              label="Required"
              help="Visitor must answer to continue"
              onChange={(v) => set({ required: v })}
            />
            {page.type === "multi_choice" && (
              <Field label="Max selections" className="mt-3">
                <input
                  type="number"
                  value={page.max_selections ?? ""}
                  onChange={(e) =>
                    set({ max_selections: Number(e.currentTarget.value) || undefined })
                  }
                  className="h-8 max-w-[100px] rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            )}
          </Section>
        )}

        {page.type === "number_input" && (
          <Section title="Range">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min">
                <MonoInput value={page.min} onChange={(v) => set({ min: v })} />
              </Field>
              <Field label="Max">
                <MonoInput value={page.max} onChange={(v) => set({ max: v })} />
              </Field>
              <Field label="Step">
                <MonoInput value={page.step} onChange={(v) => set({ step: v })} />
              </Field>
            </div>
            <Field label="Suffix unit" className="mt-3">
              <LocalizedInput
                value={page.suffix}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ suffix: next })}
                placeholder="kg, lbs, years…"
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
            <div className="mt-3 border-t border-rv-divider pt-3">
              <Toggle on={!!page.required} label="Required" onChange={(v) => set({ required: v })} />
            </div>
          </Section>
        )}

        {page.type === "slider" && (
          <Section title="Slider">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min">
                <MonoInput value={page.min} onChange={(v) => set({ min: v })} />
              </Field>
              <Field label="Max">
                <MonoInput value={page.max} onChange={(v) => set({ max: v })} />
              </Field>
              <Field label="Step">
                <MonoInput value={page.step} onChange={(v) => set({ step: v })} />
              </Field>
            </div>
            <Field label="Label format · use {{value}}" className="mt-3">
              <input
                value={page.format ?? ""}
                onChange={(e) => set({ format: e.currentTarget.value })}
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          </Section>
        )}

        {page.type === "loading" && (
          <Section title="Loading">
            <Field label="Duration (ms) · 500–15000">
              <MonoInput value={page.duration} onChange={(v) => set({ duration: v })} />
            </Field>
            <Field label="Steps" className="mt-3">
              <LocalizedArrayInput
                value={page.steps}
                editLocale={editLocale}
                defaultLocale={defaultLocale}
                onChange={(next) => set({ steps: next })}
                placeholder="Step text"
              />
            </Field>
          </Section>
        )}

        {page.type === "result" && (
          <Section title="Personalization">
            <Field label="Insert from earlier questions">
              <div className="flex flex-wrap gap-1.5">
                {earlierQs.map((qid) => (
                  <span
                    key={qid}
                    className="cursor-pointer rounded border border-rv-divider bg-rv-c3 px-2 py-1 font-rv-mono text-[11px] text-rv-mute-700 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
                  >
                    {`{{${qid}}}`}
                  </span>
                ))}
              </div>
            </Field>
            <div className="mt-3 text-[11px] leading-relaxed text-rv-mute-500">
              Click a chip to insert into the title or body. Available question IDs come from all
              pages before this one.
            </div>
          </Section>
        )}

        {page.type === "paywall" && (
          <>
            <Section title="Builder paywall">
              <select
                value={page.paywallId ?? ""}
                onChange={(e) =>
                  set({ paywallId: e.currentTarget.value || undefined })
                }
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              >
                <option value="">None (legacy fields)</option>
                {builderPaywalls.map((pw) => (
                  <option key={pw.id} value={pw.id}>
                    {pw.name} · {pw.identifier}
                  </option>
                ))}
              </select>
              <div className="mt-1.5 text-[11px] leading-relaxed text-rv-mute-500">
                Renders this page with the paywall builder instead of the fields below. Only
                paywalls with a saved builder design are listed.
              </div>
            </Section>
            <Section title="Product">
              <select
                value={page.productId ?? ""}
                onChange={(e) =>
                  set({ productId: e.currentTarget.value || undefined })
                }
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              >
                <option value="">Choose a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.identifier}>
                    {p.displayName} · {p.identifier}
                  </option>
                ))}
              </select>
            </Section>
            <Section title="Trial">
              <div className="grid grid-cols-3 gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
                {[
                  { label: "None", value: undefined },
                  { label: "3 days", value: 3 },
                  { label: "7 days", value: 7 },
                ].map((t) => {
                  const active = (page.trial ?? undefined) === t.value;
                  return (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => set({ trial: t.value })}
                      className={cn(
                        "h-7 cursor-pointer rounded text-[11px] font-medium transition",
                        active
                          ? "bg-rv-c4 text-foreground"
                          : "text-rv-mute-600 hover:text-foreground",
                      )}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </Section>
          </>
        )}

        {page.type === "success" && (
          <Section title="Hand-off">
            <div className="text-[12px] leading-relaxed text-rv-mute-600">
              Configured globally in{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  vm.setActiveTab("settings");
                }}
                className="text-rv-accent-500 underline-offset-2 hover:underline"
              >
                Settings → Hand-off
              </a>
              .
            </div>
            <div className="mt-2.5 rounded border border-rv-divider bg-rv-c2 px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-700">
              <div>
                universal-link:{" "}
                <span className="text-rv-success">
                  {vm.settings.universalLinkDomain || "not set"}
                </span>
              </div>
              <div className="mt-1">
                scheme: <span className="text-foreground">{vm.settings.deepLinkScheme || "not set"}</span>
              </div>
            </div>
          </Section>
        )}

        <Section title="Style">
          <Field
            label={`Corner radius · ${page.radius ?? vm.theme.radius}px${
              page.radius === undefined ? " (theme)" : ""
            }`}
            className="mb-1"
          >
            <input
              type="range"
              min={0}
              max={28}
              step={1}
              value={page.radius ?? vm.theme.radius}
              onChange={(e) => set({ radius: Number(e.currentTarget.value) })}
              className="w-full accent-rv-accent-500"
            />
          </Field>
          {page.radius !== undefined && (
            <button
              type="button"
              onClick={() => set({ radius: undefined })}
              className="cursor-pointer text-[10px] font-medium text-rv-mute-500 underline-offset-2 hover:text-foreground hover:underline"
            >
              Reset to theme default
            </button>
          )}
        </Section>

        <Section title="Header">
          <Toggle
            on={!!page.showBack}
            label="Show back button"
            help="Adds a back chevron / arrow in the page header"
            onChange={(v) => set({ showBack: v })}
          />
          <div className="mt-3">
            <Toggle
              on={!!page.showProgress}
              label="Show progress"
              help="Renders the funnel progress bar above the content"
              onChange={(v) => set({ showProgress: v })}
            />
          </div>

          <Field label="Progress style" className="mt-4">
            <div className="grid grid-cols-2 gap-1.5">
              {PROGRESS_STYLES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => vm.updateTheme({ progressStyle: s.value })}
                  className={cn(
                    "flex cursor-pointer flex-col items-stretch gap-1.5 rounded border p-2 text-left transition",
                    vm.theme.progressStyle === s.value
                      ? "border-rv-accent-500 bg-rv-c2"
                      : "border-rv-divider bg-rv-c2 hover:border-rv-accent-500",
                  )}
                  title={s.label}
                >
                  <ProgressPreview
                    style={s.value}
                    active={vm.theme.progressActive || vm.theme.primary}
                    inactive={vm.theme.progressInactive || "rgba(0,0,0,0.1)"}
                  />
                  <span className="text-[10px] font-medium text-foreground">{s.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Active color" className="mt-3">
            <ColorSwatchInput
              value={vm.theme.progressActive}
              onChange={(v) => vm.updateTheme({ progressActive: v })}
              placeholder={vm.theme.primary}
              size="sm"
            />
          </Field>
          <Field label="Inactive color" className="mt-3">
            <ColorSwatchInput
              value={vm.theme.progressInactive}
              onChange={(v) => vm.updateTheme({ progressInactive: v })}
              placeholder="rgba(0,0,0,0.1)"
              size="sm"
            />
          </Field>

          <Field label="Back button icon" className="mt-3">
            <div className="grid grid-cols-2 gap-1.5">
              {BACK_ICONS.map((b) => {
                const I = b.icon;
                return (
                  <button
                    key={b.value}
                    type="button"
                    onClick={() => vm.updateTheme({ backIcon: b.value })}
                    className={cn(
                      "flex cursor-pointer items-center justify-center gap-2 rounded border px-2 py-2 text-[12px] transition",
                      vm.theme.backIcon === b.value
                        ? "border-rv-accent-500 bg-rv-c2 text-foreground"
                        : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:border-rv-accent-500",
                    )}
                  >
                    <I size={14} strokeWidth={2.2} />
                    <span>{b.label}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        </Section>

        <Section title="Background">
          <Field label="Kind" className="mb-3">
            <Segmented
              value={page.background?.kind ?? "none"}
              onChange={(k) =>
                vm.updateBackground(page.id, {
                  kind: k as "none" | "color" | "image" | "video",
                })
              }
              options={[
                { value: "none", label: "Theme" },
                { value: "color", label: "Color" },
                { value: "image", label: "Image" },
                { value: "video", label: "Video" },
              ]}
            />
          </Field>
          {page.background?.kind && page.background.kind !== "none" && (
            <>
              <Field
                label={page.background.kind === "color" ? "Color (hex)" : "URL"}
                className="mb-3"
              >
                {page.background.kind === "color" ? (
                  <ColorSwatchInput
                    value={page.background.value}
                    onChange={(v) => vm.updateBackground(page.id, { value: v })}
                    placeholder="#0F172A"
                  />
                ) : (
                  <input
                    value={page.background.value}
                    onChange={(e) =>
                      vm.updateBackground(page.id, { value: e.currentTarget.value })
                    }
                    placeholder="https://…"
                    className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                )}
              </Field>
              <Field
                label={`Opacity · ${Math.round((page.background.opacity ?? 1) * 100)}%`}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={page.background.opacity ?? 1}
                  onChange={(e) =>
                    vm.updateBackground(page.id, {
                      opacity: Number(e.currentTarget.value),
                    })
                  }
                  className="w-full accent-rv-accent-500"
                />
              </Field>
            </>
          )}
        </Section>

        {hasCta && (
          <Section title="Footer">
            <Toggle
              on={page.footer?.enabled !== false}
              label="Enable footer"
              help="Renders the band that contains the primary button"
              onChange={(v) => vm.updateFooter(page.id, { enabled: v })}
            />
            {page.footer?.enabled !== false && (
              <>
                {ctaEditable && (
                  <Field label="Button label" className="mt-3 mb-3">
                    <LocalizedInput
                      value={page.cta}
                      editLocale={editLocale}
                      defaultLocale={defaultLocale}
                      onChange={(next) => set({ cta: next })}
                      placeholder={ctaPlaceholder}
                      className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                    />
                  </Field>
                )}
                <Field label="Footer bg color" className="mb-3">
                  <ColorSwatchInput
                    value={page.footer?.bgColor ?? ""}
                    onChange={(v) => vm.updateFooter(page.id, { bgColor: v })}
                    placeholder="#F4F4F5"
                  />
                </Field>
                <Field label="Button color" className="mb-3">
                  <ColorSwatchInput
                    value={page.footer?.buttonColor ?? ""}
                    onChange={(v) => vm.updateFooter(page.id, { buttonColor: v })}
                    placeholder={vm.theme.primary}
                    inheritedColor={vm.theme.primary}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-2">
                  <Field label="Border color">
                    <ColorSwatchInput
                      value={page.footer?.borderColor ?? ""}
                      onChange={(v) => vm.updateFooter(page.id, { borderColor: v })}
                      placeholder="#E4E4E7"
                    />
                  </Field>
                  <Field label={`Border · ${page.footer?.borderWidth ?? 0}px`}>
                    <input
                      type="range"
                      min={0}
                      max={4}
                      step={1}
                      value={page.footer?.borderWidth ?? 0}
                      onChange={(e) =>
                        vm.updateFooter(page.id, {
                          borderWidth: Number(e.currentTarget.value),
                        })
                      }
                      className="w-full accent-rv-accent-500"
                    />
                  </Field>
                </div>
              </>
            )}
          </Section>
        )}

        <Accordion
          title="Branching"
          right={
            <>
              {rules.length > 0 && (
                <span className="rounded bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
                  {rules.length}
                </span>
              )}
              <Plus size={12} className="text-rv-mute-500" />
            </>
          }
        >
          {earlierQs.length === 0 ? (
            <div className="rounded border border-rv-accent-500/25 bg-rv-accent-500/[0.08] p-2.5 text-[11px] leading-relaxed text-rv-mute-700">
              No earlier questions yet. Branching can only reference pages before this one.
            </div>
          ) : (
            <>
              {rules.length === 0 && (
                <div className="mb-2 text-[11px] leading-relaxed text-rv-mute-500">
                  Rules evaluate top-to-bottom. First match wins, then jump to its target. Otherwise
                  visitors fall through to the default below.
                </div>
              )}
              <RuleEditor pageId={page.id} />
              <div className="mt-3 flex items-center gap-2 rounded bg-rv-c2 px-2.5 py-2 text-[11px] text-rv-mute-600">
                <span>Otherwise</span>
                <ArrowRight size={11} className="text-rv-mute-500" />
                <select
                  value={vm.defaultNext[page.id] ?? ""}
                  onChange={(e) =>
                    vm.setDefaultNext(page.id, e.currentTarget.value || null)
                  }
                  className="h-6 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                >
                  <option value="">next page ↓</option>
                  {vm.pages
                    .filter((p) => p.id !== page.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  <option value="paywall">⟶ paywall</option>
                  <option value="end">⟶ end</option>
                </select>
              </div>
            </>
          )}
        </Accordion>
      </div>
    </aside>
  );
});

/**
 * Collapsible sidebar section. Titled sections render an accordion header
 * with a chevron and remember their open state locally (resets when the
 * panel re-mounts for a new page selection, which keeps long sidebars from
 * staying scrolled to a stale spot).
 *
 * When `title` is omitted, the section becomes a plain always-open
 * container — used for the page-type badge header at the top of the panel.
 */
function Section({
  title,
  right,
  defaultOpen = false,
  children,
}: {
  title?: string;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!title) {
    return <section className="border-b border-rv-divider px-4 py-3.5">{children}</section>;
  }
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
        <div className="flex items-center gap-2">
          {right}
          <ChevronDown
            size={12}
            className={cn(
              "text-rv-mute-500 transition-transform duration-150",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
        </div>
      </button>
      {open && <div className="px-4 pb-3.5">{children}</div>}
    </section>
  );
}

/**
 * Thin alias kept for sections that already need a bolder header style with
 * a custom right-slot (e.g. Branching count chip). Renders the same
 * collapsible behaviour as `Section`.
 */
function Accordion({
  title,
  right,
  defaultOpen = false,
  children,
}: {
  title: string;
  right?: React.ReactNode;
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
        <h4 className="m-0 text-[12px] font-semibold text-foreground">{title}</h4>
        <div className="flex items-center gap-2">
          {right}
          <ChevronDown
            size={12}
            className={cn(
              "text-rv-mute-500 transition-transform duration-150",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
        </div>
      </button>
      {open && <div className="px-4 pb-3.5">{children}</div>}
    </section>
  );
}

function Toggle({
  on,
  label,
  help,
  onChange,
}: {
  on: boolean;
  label: string;
  help?: string;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-1.5"
      onClick={() => onChange?.(!on)}
    >
      <div className="text-[12px] text-rv-mute-700" title={help}>
        {label}
        {help && <span className="ml-1 cursor-help text-[10px] text-rv-mute-500">?</span>}
      </div>
      <div
        role="switch"
        aria-checked={on}
        className={cn(
          "relative h-4 w-7 cursor-pointer rounded-full transition",
          on ? "bg-rv-accent-500" : "bg-rv-c4",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
            on ? "left-3.5" : "left-0.5",
          )}
        />
      </div>
    </div>
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

function MonoInput({
  value,
  onChange,
}: {
  value?: string | number;
  onChange?: (v: number | undefined) => void;
}) {
  return (
    <input
      value={value ?? ""}
      onChange={(e) => {
        const v = e.currentTarget.value;
        onChange?.(v === "" ? undefined : Number(v));
      }}
      className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
    />
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; icon?: React.ReactNode }>;
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
            "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded text-[11px] font-medium transition",
            value === o.value ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AnswerTypeDropdown({
  value,
  onChange,
}: {
  value: PageType;
  onChange: (t: PageType) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PAGE_TYPES[value];
  const CurIco = current.icon;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2 transition hover:bg-rv-c3"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
          <CurIco size={13} />
        </div>
        <div className="flex-1 text-left text-[13px] text-foreground">{current.label}</div>
        <ChevronDown
          size={14}
          className={cn(
            "text-rv-mute-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[49]" onClick={() => setOpen(false)} />
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 z-50 mt-1 max-h-[480px] w-[320px] overflow-y-auto rounded-lg border border-rv-divider-strong bg-rv-c1 p-2 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
          >
            {PAGE_GROUPS.map((g) => (
              <div key={g.label} className="mt-2 first:mt-0">
                <div className="mb-1 px-2 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                  {g.label}
                </div>
                <div className="flex flex-col gap-0.5">
                  {g.types.map((t) => {
                    const m = PAGE_TYPES[t];
                    const I = m.icon;
                    const active = t === value;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          onChange(t);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition",
                          active
                            ? "bg-rv-accent-500/15 text-rv-accent-500"
                            : "text-foreground hover:bg-rv-c2",
                        )}
                      >
                        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
                          <I size={13} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium">{m.label}</div>
                          <div className="text-[10px] text-rv-mute-500">
                            {PAGE_TYPE_DESC[t]}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProgressPreview({
  style,
  active,
  inactive,
}: {
  style: ProgressStyle;
  active: string;
  inactive: string;
}) {
  if (style === "segmented") {
    return (
      <div className="flex items-center gap-[2px]">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className="block h-[3px] flex-1 rounded-full"
            style={{ background: i < 3 ? active : inactive }}
          />
        ))}
      </div>
    );
  }
  if (style === "dashed") {
    return (
      <div className="relative h-[5px]">
        <div
          className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
          style={{
            backgroundImage: `repeating-linear-gradient(to right, ${inactive} 0 5px, transparent 5px 9px)`,
          }}
        />
        <div className="relative h-[3px] w-[60%] overflow-hidden rounded-full" style={{ background: active }} />
      </div>
    );
  }
  const height = style === "rounded" ? "h-[5px]" : "h-[3px]";
  return (
    <div className={`${height} overflow-hidden rounded-full`} style={{ background: inactive }}>
      <span className="block h-full w-[60%] rounded-full" style={{ background: active }} />
    </div>
  );
}
