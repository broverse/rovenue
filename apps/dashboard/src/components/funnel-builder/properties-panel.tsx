import { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  Code,
  Image as ImageIcon,
  Play,
  Plus,
  Type as TypeIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { PAGE_TYPES, type Page, type Rule } from "./types";
import { RuleEditor } from "./rule-editor";

type Props = {
  page: Page;
  allPages: Page[];
  allRules: Record<string, Rule[]>;
};

/**
 * Right rail in the Content tab. Switches its contents based on the
 * selected page's type — single/multi choice, slider, paywall, etc.
 * Branching is always available (subject to the page having earlier
 * questions to reference).
 */
export function PropertiesPanel({ page, allPages, allRules }: Props) {
  const meta = PAGE_TYPES[page.type];
  const Ico = meta.icon;
  const rules = allRules[page.id] ?? [];
  const sourceIndex = allPages.findIndex((p) => p.id === page.id);
  const earlierQs = allPages
    .slice(0, sourceIndex)
    .filter((p) => p.question_id)
    .map((p) => p.question_id as string);
  const [qTab, setQTab] = useState<"text" | "video">("text");

  const isQuestionPage = !!page.question_id;
  const headerLabel = isQuestionPage ? "Question" : meta.label;

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
        {isQuestionPage && (
          <Section>
            <Segmented
              value={qTab}
              onChange={setQTab}
              options={[
                { value: "text", label: "Text", icon: <TypeIcon size={12} /> },
                { value: "video", label: "Video", icon: <Play size={12} /> },
              ]}
            />
          </Section>
        )}

        <Section title={isQuestionPage ? "Answer type" : "Page type"}>
          <div className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
              <Ico size={13} />
            </div>
            <div className="flex-1 text-[13px] text-foreground">{meta.label}</div>
            <ChevronDown size={14} className="text-rv-mute-500" />
          </div>
        </Section>

        {(page.type === "single_choice" || page.type === "multi_choice") && (
          <Section title="Behavior">
            <Toggle on={!!page.required} label="Required" help="Visitor must answer to continue" />
            <Toggle
              on={page.type === "multi_choice"}
              label="Multiple selection"
              help="Visitor can pick more than one option"
            />
            <Toggle on={false} label="Randomize order" help="Shuffle options each session" />
            <Toggle on={false} label='Add "Other" option' help="Adds a free-text fallback choice" />
            <Toggle on={true} label="Vertical alignment" />
            <Toggle on={false} label="Map to contacts" help="Sync answer to your CRM field" />
            {page.type === "multi_choice" && (
              <Field label="Max selections" className="mt-3">
                <input
                  type="number"
                  defaultValue={page.max_selections}
                  className="h-8 max-w-[100px] rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                />
              </Field>
            )}
          </Section>
        )}

        {page.type === "number_input" && (
          <Section title="Range">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min"><MonoInput defaultValue={page.min} /></Field>
              <Field label="Max"><MonoInput defaultValue={page.max} /></Field>
              <Field label="Step"><MonoInput defaultValue={page.step} /></Field>
            </div>
            <Field label="Suffix unit" className="mt-3">
              <input
                defaultValue={page.suffix}
                placeholder="kg, lbs, years…"
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              />
            </Field>
            <div className="mt-3 border-t border-rv-divider pt-3">
              <Toggle on={!!page.required} label="Required" />
            </div>
          </Section>
        )}

        {page.type === "slider" && (
          <Section title="Slider">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min"><MonoInput defaultValue={page.min} /></Field>
              <Field label="Max"><MonoInput defaultValue={page.max} /></Field>
              <Field label="Step"><MonoInput defaultValue={page.step} /></Field>
            </div>
            <Field label="Label format · use {{value}}" className="mt-3">
              <MonoInput defaultValue={page.format} />
            </Field>
          </Section>
        )}

        {page.type === "loading" && (
          <Section title="Loading">
            <Field label="Duration (ms) · 500–15000">
              <MonoInput defaultValue={page.duration} />
            </Field>
            <Field label="Steps · one per line" className="mt-3">
              <textarea
                defaultValue={(page.steps ?? []).join("\n")}
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
              <div className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-rv-warning to-[#fb923c] text-[12px] font-bold text-white">
                  P
                </div>
                <div className="flex-1 text-[13px] text-foreground">Pro · Annual</div>
                <ChevronDown size={14} className="text-rv-mute-500" />
              </div>
              <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
                {page.productId} · $79.99/yr
              </div>
            </Section>
            <Section title="Trial">
              <div className="grid grid-cols-3 gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
                {[
                  ["None", false],
                  ["3 days", false],
                  ["7 days", true],
                ].map(([label, active]) => (
                  <button
                    key={String(label)}
                    type="button"
                    className={cn(
                      "h-7 cursor-pointer rounded text-[11px] font-medium transition",
                      active
                        ? "bg-rv-c4 text-foreground"
                        : "text-rv-mute-600 hover:text-foreground",
                    )}
                  >
                    {label as string}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Display">
              <Toggle on={true} label="Show trial badge" />
              <Toggle on={true} label="Show price footnote" />
              <Toggle on={false} label="Hide skip option" help="Force the visitor to act on the paywall" />
            </Section>
          </>
        )}

        {page.type === "success" && (
          <Section title="Hand-off">
            <div className="text-[12px] leading-relaxed text-rv-mute-600">
              Configured globally in{" "}
              <a href="#" className="text-rv-accent-500 underline-offset-2 hover:underline">
                Settings → Hand-off
              </a>
              :
            </div>
            <div className="mt-2.5 rounded border border-rv-divider bg-rv-c2 px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-700">
              <div>
                universal-link: <span className="text-rv-success">funnels.posely.app ✓</span>
              </div>
              <div className="mt-1">
                scheme: <span className="text-foreground">posely://</span>
              </div>
            </div>
          </Section>
        )}

        {page.type !== "paywall" && page.type !== "success" && (
          <Accordion title="Image or video">
            <div className="flex flex-col items-center gap-1 rounded border border-dashed border-rv-divider-strong bg-rv-c2 px-3 py-5 text-[11px] text-rv-mute-500">
              <ImageIcon size={14} />
              <span>Drop image or paste URL</span>
            </div>
          </Accordion>
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
              {rules.map((r, i) => (
                <RuleEditor key={r.id} rule={r} idx={i} pageId={page.id} allPages={allPages} />
              ))}
              <button
                type="button"
                className="mt-2.5 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
              >
                <Plus size={11} />
                Add rule
              </button>
              <div className="mt-3 flex items-center gap-2 rounded bg-rv-c2 px-2.5 py-2 text-[11px] text-rv-mute-600">
                <span>Otherwise</span>
                <ArrowRight size={11} className="text-rv-mute-500" />
                <select
                  defaultValue=""
                  className="h-6 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                >
                  <option value="">next page ↓</option>
                  {allPages
                    .filter((p) => p.id !== page.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  <option value="paywall">⟶ paywall</option>
                </select>
              </div>
            </>
          )}
        </Accordion>

        <Section title="Comments">
          <div className="text-[11px] text-rv-mute-500">
            No comments yet. Tag a teammate to discuss this page.
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
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
}: {
  on: boolean;
  label: string;
  help?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="text-[12px] text-rv-mute-700" title={help}>
        {label}
        {help && (
          <span className="ml-1 cursor-help text-[10px] text-rv-mute-500">?</span>
        )}
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

function MonoInput({ defaultValue }: { defaultValue?: string | number }) {
  return (
    <input
      defaultValue={defaultValue}
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
  options: ReadonlyArray<{ value: T; label: string; icon: React.ReactNode }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded text-[11px] font-medium transition",
            value === o.value
              ? "bg-rv-c4 text-foreground"
              : "text-rv-mute-600 hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
