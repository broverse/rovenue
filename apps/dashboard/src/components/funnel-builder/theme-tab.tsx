import { component, useService } from "impair";
import { Check, Image as ImageIcon, TriangleAlert } from "lucide-react";
import type { Theme } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { PagePreview } from "./page-preview";

const COLOR_ROWS: ReadonlyArray<{ key: keyof Theme; label: string; hint: string }> = [
  { key: "primary", label: "Primary color", hint: "Buttons, progress, accents on every page" },
  { key: "accent", label: "Accent color", hint: "Secondary highlights and result chips" },
  { key: "bg", label: "Background", hint: "Page background under content" },
  { key: "text", label: "Text", hint: "Default body and heading color" },
];

const SWATCH_ROWS = [
  ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EC4899", "#06B6D4"],
  ["#FAFAFA", "#FFFFFF", "#F4F4F5", "#0F0F12", "#18181B", "#27272A"],
];

export const ThemeTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const theme = vm.theme;
  const currentPage = vm.selectedPage ?? vm.pages[0];

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <Section>
            <SectionHead title="Brand" icon={<ImageIcon size={14} />} />
            <Field label="Logo">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[10px] text-[22px] font-bold text-white"
                  style={{ background: theme.primary }}
                >
                  {theme.logoLetter || "F"}
                </div>
                <div className="flex-1">
                  <input
                    value={theme.logoUrl}
                    onChange={(e) => vm.updateTheme({ logoUrl: e.currentTarget.value })}
                    placeholder="https://your-cdn.com/logo.svg"
                    className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                  <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
                    SVG or PNG · transparent background recommended · &lt; 200 KB
                  </div>
                </div>
              </div>
            </Field>
          </Section>

          <Section>
            <SectionHead title="Colors" />
            {COLOR_ROWS.map((c) => (
              <div
                key={c.key}
                className="flex items-center gap-3 border-b border-rv-divider py-3 last:border-b-0"
              >
                <div
                  className="h-9 w-9 flex-shrink-0 rounded-md border border-rv-divider"
                  style={{ background: theme[c.key] as string }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{c.label}</div>
                  <div className="text-[11px] text-rv-mute-500">{c.hint}</div>
                </div>
                <input
                  value={theme[c.key] as string}
                  onChange={(e) =>
                    vm.updateTheme({ [c.key]: e.currentTarget.value } as Partial<Theme>)
                  }
                  className="h-7 w-24 rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] uppercase text-foreground outline-none focus:border-rv-accent-500"
                />
              </div>
            ))}
            <div className="mt-3">
              <div className="mb-1.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                Quick swatches
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {SWATCH_ROWS[0].map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => vm.updateTheme({ primary: c, accent: c })}
                    className="h-6 w-6 cursor-pointer rounded border border-rv-divider transition hover:scale-110"
                    style={{ background: c }}
                  />
                ))}
                <span className="mx-1 text-rv-mute-500">·</span>
                {SWATCH_ROWS[1].map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => vm.updateTheme({ bg: c })}
                    className="h-6 w-6 cursor-pointer rounded border border-rv-divider transition hover:scale-110"
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
            <div className="mt-3 space-y-2">
              <ContrastRow level="pass" bold="Text on background:" text="passes AAA" />
              <ContrastRow
                level="warn"
                bold="Accent on background:"
                text="check contrast for body copy"
              />
            </div>
          </Section>

          <Section>
            <SectionHead title="Typography" />
            <Field label="Font family">
              <select
                value={theme.font}
                onChange={(e) => vm.updateTheme({ font: e.currentTarget.value })}
                className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
              >
                <option>Inter</option>
                <option>Geist</option>
                <option>SF Pro</option>
                <option>Roboto</option>
                <option>System default</option>
              </select>
            </Field>
            <div
              className="mt-2 rounded-md bg-rv-c2 px-4 py-4"
              style={{ fontFamily: theme.font || "Inter" }}
            >
              <div className="mb-1 text-[20px] font-bold tracking-tight">Heading sample</div>
              <div className="text-[13px] text-rv-mute-700">
                Body copy renders with this font on every page.
              </div>
            </div>
          </Section>
        </div>

        <div className="sticky top-4 self-start">
          <Section className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
              <h3 className="m-0 text-[13px] font-semibold">Live preview</h3>
              <span className="font-rv-mono text-[11px] text-rv-mute-500">{currentPage?.id}</span>
            </div>
            <div className="bg-gradient-to-b from-rv-c1 to-rv-bg px-4 py-5">
              <div className="mx-auto h-[520px] w-[260px] rounded-[36px] border border-rv-divider-strong bg-rv-c1 p-2 shadow-[0_18px_38px_rgba(0,0,0,0.5)]">
                <div className="relative h-full w-full overflow-hidden rounded-[28px]">
                  <div className="absolute left-1/2 top-1.5 z-10 h-1.5 w-16 -translate-x-1/2 rounded-full bg-black/40" />
                  {currentPage && <PagePreview page={currentPage} theme={theme} />}
                </div>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
});

function Section({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4 ${className}`}>
      {children}
    </section>
  );
}

function SectionHead({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <h3 className="m-0 mb-3 flex items-center gap-2 text-[13px] font-semibold">
      {icon}
      {title}
    </h3>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function ContrastRow({
  level,
  bold,
  text,
}: {
  level: "pass" | "warn";
  bold: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2 text-[11px] text-rv-mute-600">
      {level === "pass" ? (
        <Check size={13} className="mt-0.5 flex-shrink-0 text-rv-success" />
      ) : (
        <TriangleAlert size={13} className="mt-0.5 flex-shrink-0 text-rv-warning" />
      )}
      <div>
        <b className="text-foreground">{bold}</b> {text}
      </div>
    </div>
  );
}
