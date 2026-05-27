import { useState } from "react";
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronDown,
  Code,
  Image as ImageIcon,
  Play,
  Plus,
  Type as TypeIcon,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { rpc, unwrap } from "../../lib/api";
import { PAGE_GROUPS, PAGE_TYPE_DESC, PAGE_TYPES, type Page, type PageType } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { RuleEditor } from "./rule-editor";
import { ColorSwatchInput } from "./color-swatch-input";

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

export const PropertiesPanel = component(() => {
  // Hooks must run unconditionally on every render — keep them above any
  // `return null`. React throws "Should have a queue" otherwise when the
  // selected page flips from undefined to set between renders.
  const vm = useService(FunnelDraftViewModel);
  const { data: products = [] } = useProjectProducts(vm.projectId);

  const page = vm.selectedPage;
  if (!page) {
    return (
      <aside className="flex w-[340px] flex-shrink-0 flex-col items-center justify-center border-l border-rv-divider bg-rv-c1 px-6 text-center">
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
                <input
                  value={page.title ?? ""}
                  onChange={(e) => set({ title: e.currentTarget.value })}
                  placeholder="Your question or screen title"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              {page.type !== "loading" && page.type !== "result" && (
                <Field label="Subtitle" className="mb-3">
                  <input
                    value={page.subtitle ?? ""}
                    onChange={(e) => set({ subtitle: e.currentTarget.value })}
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
                    <input
                      value={o.label}
                      onChange={(e) => vm.updateOption(page.id, i, { label: e.currentTarget.value })}
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
              <textarea
                value={page.body ?? ""}
                onChange={(e) => set({ body: e.currentTarget.value })}
                rows={4}
                placeholder="Hello, world."
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {page.type === "result" && (
            <Field label="Body">
              <textarea
                value={page.body ?? ""}
                onChange={(e) => set({ body: e.currentTarget.value })}
                rows={3}
                placeholder="Supports {{question_id}} tokens"
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
          )}

          {page.type === "paywall" && (
            <>
              <Field label="Headline" className="mb-3">
                <input
                  value={page.headline ?? ""}
                  onChange={(e) => set({ headline: e.currentTarget.value })}
                  placeholder="Unlock your plan"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label={`Benefits · ${(page.benefits ?? []).length}`}>
                <div className="flex flex-col gap-1.5">
                  {(page.benefits ?? []).map((b, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-1.5 py-1"
                    >
                      <input
                        value={b}
                        onChange={(e) => {
                          const next = [...(page.benefits ?? [])];
                          next[i] = e.currentTarget.value;
                          set({ benefits: next });
                        }}
                        placeholder="Benefit line"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none"
                      />
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => {
                          const next = [...(page.benefits ?? [])];
                          next.splice(i, 1);
                          set({ benefits: next });
                        }}
                        className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => set({ benefits: [...(page.benefits ?? []), "New benefit"] })}
                    className="mt-1 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
                  >
                    <Plus size={11} />
                    Add benefit
                  </button>
                </div>
              </Field>
            </>
          )}

          {page.type === "success" && (
            <>
              <Field label="Headline" className="mb-3">
                <input
                  value={page.title ?? ""}
                  onChange={(e) => set({ title: e.currentTarget.value })}
                  placeholder="You're in"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="Body" className="mb-3">
                <input
                  value={page.body ?? ""}
                  onChange={(e) => set({ body: e.currentTarget.value })}
                  placeholder="What happens next"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="CTA label">
                <input
                  value={page.cta ?? ""}
                  onChange={(e) => set({ cta: e.currentTarget.value })}
                  placeholder="Open app"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            </>
          )}

          {page.type === "loading" && (
            <Field label="Steps · one per line">
              <textarea
                value={(page.steps ?? []).join("\n")}
                onChange={(e) =>
                  set({ steps: e.currentTarget.value.split("\n").filter(Boolean) })
                }
                rows={4}
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
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
              <input
                value={page.placeholder ?? ""}
                onChange={(e) => set({ placeholder: e.currentTarget.value })}
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
                <input
                  value={page.agreementLabel ?? ""}
                  onChange={(e) => set({ agreementLabel: e.currentTarget.value })}
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
                <textarea
                  value={page.body ?? ""}
                  onChange={(e) => set({ body: e.currentTarget.value })}
                  rows={3}
                  className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              {page.type === "welcome" && (
                <Field label="Start button label">
                  <input
                    value={page.cta ?? ""}
                    onChange={(e) => set({ cta: e.currentTarget.value })}
                    placeholder="Get started"
                    className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </Field>
              )}
            </>
          )}

          {/* Statement — body + CTA */}
          {page.type === "statement" && (
            <>
              <Field label="Body" className="mb-3">
                <textarea
                  value={page.body ?? ""}
                  onChange={(e) => set({ body: e.currentTarget.value })}
                  rows={3}
                  className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label="Button label">
                <input
                  value={page.cta ?? ""}
                  onChange={(e) => set({ cta: e.currentTarget.value })}
                  placeholder="Continue"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            </>
          )}

          {/* Feature screen — headline + bulleted feature lines + CTA */}
          {page.type === "feature" && (
            <>
              <Field label="Headline" className="mb-3">
                <input
                  value={page.headline ?? ""}
                  onChange={(e) => set({ headline: e.currentTarget.value })}
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <Field label={`Features · ${(page.features ?? []).length}`} className="mb-3">
                <div className="flex flex-col gap-1.5">
                  {(page.features ?? []).map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-1.5 py-1"
                    >
                      <input
                        value={f}
                        onChange={(e) => {
                          const next = [...(page.features ?? [])];
                          next[i] = e.currentTarget.value;
                          set({ features: next });
                        }}
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none"
                      />
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => {
                          const next = [...(page.features ?? [])];
                          next.splice(i, 1);
                          set({ features: next });
                        }}
                        className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      set({ features: [...(page.features ?? []), "New feature"] })
                    }
                    className="mt-1 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
                  >
                    <Plus size={11} />
                    Add feature
                  </button>
                </div>
              </Field>
              <Field label="Button label">
                <input
                  value={page.cta ?? ""}
                  onChange={(e) => set({ cta: e.currentTarget.value })}
                  placeholder="Continue"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
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
              <input
                value={page.suffix ?? ""}
                onChange={(e) => set({ suffix: e.currentTarget.value })}
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
            <Field label="Steps · one per line" className="mt-3">
              <textarea
                value={(page.steps ?? []).join("\n")}
                onChange={(e) =>
                  set({ steps: e.currentTarget.value.split("\n").filter(Boolean) })
                }
                rows={4}
                className="w-full resize-none rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
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

        <Section title="Footer">
          <Toggle
            on={!!page.footer?.enabled}
            label="Enable footer"
            help="Style the band that contains the primary button"
            onChange={(v) =>
              vm.updateFooter(page.id, {
                enabled: v,
                text: page.footer?.text ?? "© Your brand",
              })
            }
          />
          {page.footer?.enabled && (
            <>
              <Field label="Text" className="mt-3 mb-3">
                <input
                  value={page.footer.text ?? ""}
                  onChange={(e) =>
                    vm.updateFooter(page.id, { text: e.currentTarget.value })
                  }
                  placeholder="© Your brand"
                  className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
              <div className="grid grid-cols-1 gap-2 mb-3">
                <Field label="Text color">
                  <ColorSwatchInput
                    value={page.footer.textColor ?? ""}
                    onChange={(v) => vm.updateFooter(page.id, { textColor: v })}
                    placeholder="#666666"
                  />
                </Field>
                <Field label="Bg color">
                  <ColorSwatchInput
                    value={page.footer.bgColor ?? ""}
                    onChange={(v) => vm.updateFooter(page.id, { bgColor: v })}
                    placeholder="#F4F4F5"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Field label="Border color">
                  <ColorSwatchInput
                    value={page.footer.borderColor ?? ""}
                    onChange={(v) => vm.updateFooter(page.id, { borderColor: v })}
                    placeholder="#E4E4E7"
                  />
                </Field>
                <Field label={`Border · ${page.footer.borderWidth ?? 0}px`}>
                  <input
                    type="range"
                    min={0}
                    max={4}
                    step={1}
                    value={page.footer.borderWidth ?? 0}
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

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-rv-divider px-4 py-3.5">
      {title && (
        <h4 className="mb-2.5 m-0 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          {title}
        </h4>
      )}
      {children}
    </section>
  );
}

function Accordion({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-rv-divider">
      <header className="flex items-center justify-between px-4 py-3">
        <h4 className="m-0 text-[12px] font-semibold text-foreground">{title}</h4>
        <div className="flex items-center gap-2">{right}</div>
      </header>
      <div className="px-4 pb-3.5">{children}</div>
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
