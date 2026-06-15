import { component, useService } from "impair";
import { useState } from "react";
import { Check, Copy, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  useAttachCustomDomain,
  useCustomDomains,
  useDeleteCustomDomain,
  useVerifyCustomDomain,
  type CustomDomain,
} from "../../lib/hooks/useCustomDomains";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SettingsTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const s = vm.settings;
  const save = () => vm.saveNow("settings");

  const errors = {
    iosUrl: validateStoreUrl(s.iosUrl, "apps.apple.com"),
    androidUrl: validateStoreUrl(s.androidUrl, "play.google.com"),
    universalLinkDomain: validateHostname(s.universalLinkDomain, true),
    deepLinkScheme: validateScheme(s.deepLinkScheme, true),
  };
  const storeLinksOk = !errors.iosUrl && !errors.androidUrl;
  const handoffOk = !errors.universalLinkDomain && !errors.deepLinkScheme;

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4">
        <CustomDomainSection projectId={vm.projectId} funnelId={vm.funnelId} />

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

// ---------------------------------------------------------------
// Custom-domain section — row-driven (not part of the settings blob).
// Owns its own fetch/mutation lifecycle so the parent SettingsTab
// never has to know about API state for this slice.
// ---------------------------------------------------------------

function CustomDomainSection({ projectId, funnelId }: { projectId: string; funnelId: string }) {
  const { data: domains, isLoading } = useCustomDomains(projectId);
  const row = domains?.find((d) => d.funnelId === funnelId);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-1 text-[14px] font-semibold">Custom domain</h3>
      <p className="m-0 mb-4 text-[12px] leading-relaxed text-rv-mute-500">
        Serve this funnel from your own hostname. Point a CNAME at{" "}
        <span className="font-rv-mono text-foreground">edge.rovenue.io</span> plus a TXT record at{" "}
        <span className="font-rv-mono text-foreground">_rovenue.{`{hostname}`}</span>, then click
        Verify. Leave blank to keep the default{" "}
        <span className="font-rv-mono text-foreground">{`{slug}.rovenue.io`}</span> URL.
      </p>

      {isLoading ? (
        <div className="text-[12px] text-rv-mute-500">Loading…</div>
      ) : row ? (
        <CustomDomainRow projectId={projectId} row={row} />
      ) : (
        <AddCustomDomainForm projectId={projectId} funnelId={funnelId} />
      )}
    </section>
  );
}

function AddCustomDomainForm({ projectId, funnelId }: { projectId: string; funnelId: string }) {
  const [hostname, setHostname] = useState("");
  const attach = useAttachCustomDomain(projectId);
  const error = validateHostname(hostname, false);
  const canSubmit = !!hostname.trim() && !error && !attach.isPending;
  const apiError = attach.error instanceof Error ? attach.error.message : null;

  const submit = () => {
    if (!canSubmit) return;
    attach.mutate(
      { funnelId, hostname: hostname.trim().toLowerCase() },
      {
        onSuccess: () => setHostname(""),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label="Hostname" help="like quiz.acme.com" error={error}>
        <div className="flex items-center gap-2">
          <MonoInput
            value={hostname}
            onChange={(v) => setHostname(v.toLowerCase().trim())}
            invalid={!!error}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded bg-rv-accent-500 px-3 text-[12px] font-medium text-white transition hover:bg-rv-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {attach.isPending ? "Adding…" : "Add domain"}
          </button>
        </div>
      </Field>
      {apiError && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rv-danger">
          <TriangleAlert size={12} className="mt-0.5 flex-shrink-0" />
          {humanizeAttachError(apiError)}
        </div>
      )}
    </div>
  );
}

function CustomDomainRow({ projectId, row }: { projectId: string; row: CustomDomain }) {
  const verify = useVerifyCustomDomain(projectId);
  const remove = useDeleteCustomDomain(projectId);
  const isVerified = !!row.verifiedAt;
  const isServing = isVerified && row.certStatus === "issued";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="font-rv-mono text-[13px] text-foreground">{row.hostname}</div>
          <div className="mt-0.5 text-[11px]">
            <StatusBadge row={row} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isVerified && (
            <button
              type="button"
              onClick={() => verify.mutate(row.id)}
              disabled={verify.isPending}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2.5 text-[11px] font-medium text-foreground transition hover:bg-rv-c3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={11} className={verify.isPending ? "animate-spin" : undefined} />
              {verify.isPending ? "Checking…" : "Verify"}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Remove ${row.hostname}? DNS records stay; serving stops immediately.`)) {
                remove.mutate(row.id);
              }
            }}
            disabled={remove.isPending}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 px-2.5 text-[11px] font-medium text-rv-mute-700 transition hover:border-rv-danger/50 hover:bg-rv-c3 hover:text-rv-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={11} />
            Remove
          </button>
        </div>
      </div>

      {isServing && (
        <div className="rounded-md border border-rv-success/30 bg-rv-success/[0.08] px-3 py-2.5">
          <div className="flex items-start gap-2 text-[12px] text-rv-mute-700">
            <Check size={13} className="mt-0.5 flex-shrink-0 text-rv-success" />
            <div>
              Serving at{" "}
              <a
                href={`https://${row.hostname}/`}
                target="_blank"
                rel="noreferrer"
                className="text-rv-accent-500 hover:underline"
              >
                https://{row.hostname}/
              </a>
              {row.certIssuedAt && (
                <span className="ml-1 text-rv-mute-500">
                  · cert issued {new Date(row.certIssuedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {!isVerified && (
        <DnsInstructions row={row} />
      )}

      {row.verificationFailureReason && !isVerified && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rv-danger">
          <TriangleAlert size={12} className="mt-0.5 flex-shrink-0" />
          {humanizeVerifyReason(row.verificationFailureReason)}
        </div>
      )}

      {verify.data && !verify.data.result.ok && (
        <div className="text-[11px] text-rv-mute-500">
          Last check: {humanizeVerifyReason(verify.data.result.reason ?? "unknown")}
          {verify.data.result.detail && (
            <span className="ml-1 font-rv-mono text-rv-mute-600">— {verify.data.result.detail}</span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ row }: { row: CustomDomain }) {
  if (row.verifiedAt && row.certStatus === "issued") {
    return <Badge tone="success">Serving</Badge>;
  }
  if (row.verifiedAt && row.certStatus === "issuing") {
    return <Badge tone="info">Verified · issuing certificate</Badge>;
  }
  if (row.verifiedAt && row.certStatus === "failed") {
    return <Badge tone="danger">Verified · cert failed</Badge>;
  }
  if (row.verifiedAt) {
    return <Badge tone="info">Verified · waiting on certificate</Badge>;
  }
  return <Badge tone="warn">Pending verification</Badge>;
}

function Badge({ tone, children }: { tone: "success" | "info" | "warn" | "danger"; children: React.ReactNode }) {
  const map = {
    success: "border-rv-success/40 bg-rv-success/[0.12] text-rv-success",
    info: "border-rv-accent-500/40 bg-rv-accent-500/[0.10] text-rv-accent-500",
    warn: "border-rv-warning/40 bg-rv-warning/[0.10] text-rv-warning",
    danger: "border-rv-danger/40 bg-rv-danger/[0.10] text-rv-danger",
  } as const;
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium", map[tone])}>
      {children}
    </span>
  );
}

function DnsInstructions({ row }: { row: CustomDomain }) {
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-3">
      <div className="mb-2 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        Add these DNS records
      </div>
      <DnsRow type="CNAME" name={row.verification.cname.name} value={row.verification.cname.value} />
      <div className="mt-1.5">
        <DnsRow type="TXT" name={row.verification.txt.name} value={row.verification.txt.value} />
      </div>
      <div className="mt-2 text-[11px] text-rv-mute-500">
        DNS propagation can take a few minutes. We re-check unverified rows automatically every 5 min.
      </div>
    </div>
  );
}

function DnsRow({ type, name, value }: { type: string; name: string; value: string }) {
  return (
    <div className="flex items-stretch gap-2 font-rv-mono text-[11px]">
      <span className="flex w-12 flex-shrink-0 items-center justify-center rounded bg-rv-c3 font-semibold text-rv-mute-700">
        {type}
      </span>
      <div className="min-w-0 flex-1 truncate rounded bg-rv-c1 px-2 py-1 text-foreground">{name}</div>
      <div className="min-w-0 flex-[2] truncate rounded bg-rv-c1 px-2 py-1 text-foreground">{value}</div>
      <button
        type="button"
        title="Copy value"
        onClick={() => void navigator.clipboard?.writeText(value)}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
      >
        <Copy size={11} />
      </button>
    </div>
  );
}

function humanizeAttachError(message: string): string {
  if (/hostname_taken/i.test(message)) return "That hostname is already claimed by another funnel.";
  if (/hostname_invalid/i.test(message)) return "That doesn't look like a valid hostname.";
  if (/hostname_reserved/i.test(message)) return "That hostname is reserved.";
  if (/funnel_already_has_domain/i.test(message)) return "This funnel already has a custom domain attached.";
  return message;
}

function humanizeVerifyReason(reason: string): string {
  switch (reason) {
    case "cname_missing":
      return "We can't find a CNAME for this hostname yet.";
    case "cname_mismatch":
      return "CNAME exists but doesn't point at edge.rovenue.io.";
    case "txt_missing":
      return "Missing TXT record at _rovenue.<hostname>.";
    case "txt_mismatch":
      return "TXT record exists but the verification value doesn't match.";
    case "resolver_error":
      return "DNS lookup failed — try again in a minute.";
    case "verification_window_expired":
      return "We stopped trying after 7 days without success — remove and re-add to retry.";
    default:
      return reason;
  }
}
