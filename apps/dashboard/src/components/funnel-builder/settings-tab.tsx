import { component, useService } from "impair";
import { useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SettingsTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const s = vm.settings;
  const save = () => vm.saveNow("settings");

  const errors = {
    customDomain: validateHostname(s.customDomain, false),
    iosUrl: validateStoreUrl(s.iosUrl, "apps.apple.com"),
    androidUrl: validateStoreUrl(s.androidUrl, "play.google.com"),
    universalLinkDomain: validateHostname(s.universalLinkDomain, true),
    deepLinkScheme: validateScheme(s.deepLinkScheme, true),
  };
  const customDomainOk = !errors.customDomain;
  const storeLinksOk = !errors.iosUrl && !errors.androidUrl;
  const handoffOk = !errors.universalLinkDomain && !errors.deepLinkScheme;

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4">
        <SetSection
          title="Custom domain"
          desc={
            <>
              Serve this funnel from your own hostname. Point a CNAME at{" "}
              <span className="font-rv-mono text-foreground">edge.rovenue.app</span>, then save the
              domain here. Leave blank to keep the default{" "}
              <span className="font-rv-mono text-foreground">{`{slug}.rovenue.app`}</span> URL.
            </>
          }
          onSave={save}
          canSave={customDomainOk}
        >
          <Field label="Hostname" help="like quiz.acme.com" error={errors.customDomain}>
            <MonoInput
              value={s.customDomain}
              onChange={(v) => vm.updateSettings({ customDomain: v.toLowerCase().trim() })}
              invalid={!!errors.customDomain}
            />
            {s.customDomain && !errors.customDomain && (
              <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
                Serves at{" "}
                <span className="text-foreground">https://{s.customDomain}/</span>
              </div>
            )}
          </Field>
        </SetSection>

        <SetSection
          title="Store links"
          desc="Fallback URLs when a visitor's device doesn't have your app installed. Universal links resolve here on the cold-install case."
          onSave={save}
          canSave={storeLinksOk}
        >
          <Field label="App Store URL (iOS)" required error={errors.iosUrl}>
            <MonoInput
              value={s.iosUrl}
              onChange={(v) => vm.updateSettings({ iosUrl: v })}
              invalid={!!errors.iosUrl}
            />
          </Field>
          <Field label="Play Store URL (Android)" required error={errors.androidUrl}>
            <MonoInput
              value={s.androidUrl}
              onChange={(v) => vm.updateSettings({ androidUrl: v })}
              invalid={!!errors.androidUrl}
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
          onSave={save}
          canSave={handoffOk}
        >
          <Field
            label="Universal link domain"
            required
            help="like funnels.acme.app"
            error={errors.universalLinkDomain}
          >
            <MonoInput
              value={s.universalLinkDomain}
              onChange={(v) => vm.updateSettings({ universalLinkDomain: v.toLowerCase() })}
              invalid={!!errors.universalLinkDomain}
            />
          </Field>
          <Field
            label="Deep link scheme"
            required
            help="like myapp"
            error={errors.deepLinkScheme}
          >
            <MonoInput
              value={s.deepLinkScheme}
              onChange={(v) => vm.updateSettings({ deepLinkScheme: v.toLowerCase() })}
              invalid={!!errors.deepLinkScheme}
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
          onSave={save}
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
                  s.devMode ? "left-[1.125rem]" : "left-0.5",
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

const SetSection = component(({
  title,
  desc,
  children,
  tone,
  onSave,
  canSave = true,
}: {
  title: string;
  desc: React.ReactNode;
  children: React.ReactNode;
  tone?: "danger";
  onSave?: () => void | Promise<void>;
  canSave?: boolean;
}) => {
  const vm = useService(FunnelDraftViewModel);
  // Local feedback only — the VM's autosaveStatus is global, so reading it
  // directly would show "Saved" in every section on initial load. Track our
  // own pending flag and flip a "just saved" pulse for a few seconds after
  // the click resolves successfully.
  const [pending, setPending] = useState(false);
  const [pulse, setPulse] = useState<"saved" | "error" | null>(null);
  const click = async () => {
    if (!onSave) return;
    setPending(true);
    setPulse(null);
    try {
      await onSave();
      setPulse(vm.autosaveStatus === "error" ? "error" : "saved");
    } catch {
      setPulse("error");
    } finally {
      setPending(false);
      setTimeout(() => setPulse(null), 2500);
    }
  };
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
      {onSave && (
        <div className="mt-4 flex items-center justify-end gap-2">
          {pulse === "saved" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-rv-success">
              <Check size={12} /> Saved
            </span>
          )}
          {pulse === "error" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-rv-danger">
              <TriangleAlert size={12} /> Save failed — retry
            </span>
          )}
          <button
            type="button"
            disabled={pending || !canSave}
            onClick={click}
            title={!canSave ? "Fix the highlighted errors first" : undefined}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded bg-rv-accent-500 px-3 text-[11px] font-medium text-white transition hover:bg-rv-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </section>
  );
});

function Field({
  label,
  required,
  help,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string | null;
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
      {error && (
        <div className="mt-1 text-[11px] text-rv-danger">{error}</div>
      )}
    </div>
  );
}

function MonoInput({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={cn(
        "h-8 w-full rounded border bg-rv-c2 px-2 font-rv-mono text-[12px] text-foreground outline-none",
        invalid
          ? "border-rv-danger/60 focus:border-rv-danger"
          : "border-rv-divider focus:border-rv-accent-500",
      )}
    />
  );
}

// ----- Validators ---------------------------------------------------------
// Client-side gating only — the API stores draft JSON opaquely (see
// dashboard funnels route). Validation here keeps the "Required" stars
// honest and stops obviously broken values from reaching the backend.

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SCHEME_RE = /^[a-z][a-z0-9+\-.]*$/;

function validateStoreUrl(v: string, host: string): string | null {
  if (!v.trim()) return "Required";
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:") return "Must start with https://";
    if (u.hostname !== host) return `Hostname must be ${host}`;
    return null;
  } catch {
    return "Not a valid URL";
  }
}

function validateHostname(v: string, required: boolean): string | null {
  const t = v.trim();
  if (!t) return required ? "Required" : null;
  if (!HOSTNAME_RE.test(t)) return "Use a bare hostname like quiz.acme.com";
  return null;
}

function validateScheme(v: string, required: boolean): string | null {
  const t = v.trim();
  if (!t) return required ? "Required" : null;
  if (!SCHEME_RE.test(t)) return "Lowercase letters/digits, starts with a letter";
  return null;
}
