import { component, useService } from "impair";
import { TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SettingsTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const s = vm.settings;

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4">
        <SetSection
          title="Store links"
          desc="Fallback URLs when a visitor's device doesn't have your app installed. Universal links resolve here on the cold-install case."
        >
          <Field label="App Store URL (iOS)" required>
            <MonoInput
              value={s.iosUrl}
              onChange={(v) => vm.updateSettings({ iosUrl: v })}
            />
          </Field>
          <Field label="Play Store URL (Android)" required>
            <MonoInput
              value={s.androidUrl}
              onChange={(v) => vm.updateSettings({ androidUrl: v })}
            />
          </Field>
        </SetSection>

        <SetSection
          title="Hand-off"
          desc={
            <>
              Used to bounce paid visitors into the freshly installed native app already signed
              in. Universal-link domain must point at Rovenue's claim server.{" "}
              <a href="#" className="text-rv-accent-500 hover:underline">
                Setup guide ↗
              </a>
            </>
          }
        >
          <Field label="Universal link domain" required help="like funnels.acme.app">
            <MonoInput
              value={s.universalLinkDomain}
              onChange={(v) => vm.updateSettings({ universalLinkDomain: v.toLowerCase() })}
            />
          </Field>
          <Field label="Deep link scheme" required help="like myapp">
            <MonoInput
              value={s.deepLinkScheme}
              onChange={(v) => vm.updateSettings({ deepLinkScheme: v.toLowerCase() })}
            />
            <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
              Opens as{" "}
              <span className="text-foreground">
                {s.deepLinkScheme || "scheme"}://claim?token=…
              </span>
            </div>
          </Field>
        </SetSection>

        <SetSection
          title="Developer mode"
          desc='Adds a "skip and mark paid" button to the paywall — for development only. Surfaced to the visitor on every paywall page.'
        >
          <label
            className="mt-1 inline-flex cursor-pointer items-center gap-2.5"
            onClick={(e) => {
              e.preventDefault();
              vm.updateSettings({ devMode: !s.devMode });
            }}
          >
            <span
              className={cn(
                "relative h-5 w-9 rounded-full transition",
                s.devMode ? "bg-rv-accent-500" : "bg-rv-c4",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                  s.devMode ? "left-4.5" : "left-0.5",
                )}
              />
            </span>
            <span className="text-[13px] text-rv-mute-800">Enable dev-mode skip</span>
          </label>
          {!s.devMode && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/[0.08] px-3 py-2.5">
              <TriangleAlert size={14} className="mt-0.5 flex-shrink-0 text-rv-warning" />
              <div className="text-[12px] leading-relaxed text-rv-mute-700">
                <b className="text-foreground">Off — recommended for production.</b>
                <p className="m-0 mt-0.5">
                  If you turn this on, any visitor can bypass the paywall. Use only on a
                  non-production funnel slug.
                </p>
              </div>
            </div>
          )}
        </SetSection>
      </div>
    </div>
  );
});

function SetSection({
  title,
  desc,
  children,
  tone,
}: {
  title: string;
  desc: React.ReactNode;
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <section
      className={cn(
        "rounded-lg border bg-rv-c1 px-5 py-4",
        tone === "danger" ? "border-rv-danger/30" : "border-rv-divider",
      )}
    >
      <h3 className="m-0 mb-1 text-[14px] font-semibold">{title}</h3>
      <p className="m-0 mb-4 text-[12px] leading-relaxed text-rv-mute-500">{desc}</p>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
        {required && <span className="text-rv-danger">*</span>}
        {help && (
          <span className="ml-1 normal-case font-rv-mono text-[10px] text-rv-mute-500">
            · {help}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function MonoInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      className="h-8 w-full rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none focus:border-rv-accent-500"
    />
  );
}
