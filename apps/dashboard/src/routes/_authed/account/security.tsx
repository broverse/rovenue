import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui-components/react/dialog";
import {
  AlertTriangle,
  Check,
  Download,
  KeyRound,
  Shield,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import type { MySession } from "@rovenue/shared";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
  SessionRow,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { CopyButton } from "../../../ui/copy-button";
import { OTPInput } from "../../../ui/otp-input";
import { cn } from "../../../lib/cn";
import { useMe } from "../../../lib/hooks/useMe";
import {
  useMySessions,
  useRevokeOtherSessions,
  useRevokeSession,
} from "../../../lib/hooks/useMySessions";
import { authClient } from "../../../lib/auth";

export const Route = createFileRoute("/_authed/account/security")({
  component: SecurityPage,
});

// =============================================================
// Helpers
// =============================================================

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  let os = "Unknown OS";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Firefox/.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari/.test(ua)) browser = "Safari";
  return `${browser} on ${os}`;
}

function formatLastSeen(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return iso;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function describeMeta(s: MySession): string {
  const ip = s.ipAddress ?? "unknown ip";
  return `${ip} · last active ${formatLastSeen(s.updatedAt)}`;
}

function extractSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

/** "KZSE7TZJNIYW4NB4" → "KZSE 7TZJ NIYW 4NB4" so manual entry is easier. */
function formatSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

function downloadBackupCodes(codes: readonly string[], userEmail: string) {
  const body = [
    "Rovenue — Two-factor recovery codes",
    `Account: ${userEmail}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Each code can be used once. Keep them somewhere safe.",
    "",
    ...codes,
    "",
  ].join("\n");
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rovenue-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function useQrDataUrl(uri: string | null): string | null {
  // Renders the otpauth:// URI as a PNG data URL client-side so
  // the TOTP secret never leaves the browser. Errors fall back
  // gracefully to the secret display below the QR.
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!uri) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
      color: { dark: "#0F0F12", light: "#FFFFFF" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return dataUrl;
}

// =============================================================
// Step indicator
// =============================================================

function StepIndicator({
  steps,
  current,
}: {
  steps: readonly string[];
  current: number;
}) {
  return (
    <ol className="mb-5 flex items-center justify-center gap-1.5">
      {steps.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold transition",
                done && "border-rv-success/40 bg-rv-success/15 text-rv-success",
                active && "border-rv-accent-500 bg-rv-accent-500/15 text-rv-accent-500",
                !done && !active && "border-rv-divider bg-rv-c2 text-rv-mute-500",
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <Check size={13} /> : idx + 1}
            </span>
            <span
              className={cn(
                "hidden text-[11px] font-medium sm:inline",
                active ? "text-foreground" : "text-rv-mute-500",
              )}
            >
              {label}
            </span>
            {idx < steps.length - 1 ? (
              <span
                className={cn(
                  "ml-1.5 h-px w-6 transition sm:w-10",
                  done ? "bg-rv-success/40" : "bg-rv-divider",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// =============================================================
// Setup dialog (3 steps: connect → verify → recovery codes)
// =============================================================

type SetupState =
  | { step: "loading" }
  | { step: "connect"; totpURI: string; backupCodes: string[] }
  | { step: "verify"; totpURI: string; backupCodes: string[] }
  | { step: "codes"; backupCodes: string[] }
  | { step: "error"; message: string };

function TwoFactorSetupDialog({
  open,
  email,
  onClose,
  onCompleted,
}: {
  open: boolean;
  email: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<SetupState>({ step: "loading" });
  const [code, setCode] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const stepIdx =
    state.step === "connect" || state.step === "loading"
      ? 0
      : state.step === "verify"
        ? 1
        : 2;
  const steps = useMemo(
    () => [
      t("account.security.twofa.setup.steps.connect"),
      t("account.security.twofa.setup.steps.verify"),
      t("account.security.twofa.setup.steps.save"),
    ],
    [t],
  );

  const totpURI = state.step === "connect" || state.step === "verify" ? state.totpURI : null;
  const qrDataUrl = useQrDataUrl(totpURI);
  const secret = useMemo(() => (totpURI ? extractSecret(totpURI) : null), [totpURI]);

  // Fire `/two-factor/enable` when the dialog opens, and roll back
  // a half-enrolled row when the user dismisses without verifying.
  useEffect(() => {
    if (!open) return;
    setState({ step: "loading" });
    setCode("");
    setVerifyError(null);
    setAcknowledged(false);
    let cancelled = false;
    void (async () => {
      const res = await authClient.twoFactor.enable({});
      if (cancelled) return;
      if (res.error || !res.data) {
        setState({ step: "error", message: res.error?.message ?? "Failed to start setup" });
        return;
      }
      setState({
        step: "connect",
        totpURI: res.data.totpURI,
        backupCodes: res.data.backupCodes,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = (next: boolean) => {
    if (next) return;
    // If the user bails before verifying, undo the half-enrolled
    // row so the next "Set up" call starts clean.
    if (state.step === "connect" || state.step === "verify" || state.step === "loading") {
      void authClient.twoFactor.disable({});
    }
    onClose();
  };

  const handleVerify = async (codeArg?: string) => {
    if (state.step !== "verify") return;
    const c = (codeArg ?? code).trim();
    if (c.length !== 6) return;
    setVerifyBusy(true);
    setVerifyError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: c });
    setVerifyBusy(false);
    if (res.error) {
      setVerifyError(res.error.message ?? t("auth.twofa.invalid"));
      return;
    }
    setState({ step: "codes", backupCodes: state.backupCodes });
  };

  const finish = () => {
    onCompleted();
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rv-accent-500/15 text-rv-accent-500">
                <Smartphone size={17} />
              </div>
              <div>
                <Dialog.Title className="text-[15px] font-semibold">
                  {t("account.security.twofa.setup.title")}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                  {state.step === "codes"
                    ? t("account.security.twofa.setup.subtitleCodes")
                    : t("account.security.twofa.setup.subtitle")}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            <StepIndicator steps={steps} current={stepIdx} />

            {state.step === "loading" ? (
              <div className="flex flex-col items-center gap-3 py-10 text-[12px] text-rv-mute-500">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-rv-divider border-t-rv-accent-500" />
                {t("common.loading", "Loading…")}
              </div>
            ) : null}

            {state.step === "error" ? (
              <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
                {state.message}
              </div>
            ) : null}

            {state.step === "connect" ? (
              <div className="flex flex-col items-center gap-4">
                <div className="rounded-xl border border-rv-divider bg-white p-3 shadow-sm">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={t("account.security.twofa.authenticator.qrAlt")}
                      className="block h-[200px] w-[200px]"
                    />
                  ) : (
                    <div className="flex h-[200px] w-[200px] items-center justify-center text-[11px] text-rv-mute-500">
                      {t("common.loading", "Loading…")}
                    </div>
                  )}
                </div>

                <p className="max-w-sm text-center text-[12px] leading-relaxed text-rv-mute-500">
                  {t("account.security.twofa.setup.scanHelp")}
                </p>

                <details className="w-full rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2.5 text-[12px]">
                  <summary className="cursor-pointer select-none text-rv-mute-700 hover:text-foreground">
                    {t("account.security.twofa.setup.manualToggle")}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <div>
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                        {t("account.security.twofa.authenticator.secret")}
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded bg-rv-c1 px-2.5 py-1.5 font-rv-mono text-[12px] tracking-[0.15em] text-foreground">
                          {secret ? formatSecret(secret) : ""}
                        </code>
                        <CopyButton
                          size="sm"
                          value={secret ?? ""}
                          iconSize={12}
                        />
                      </div>
                    </div>
                  </div>
                </details>

                <div className="flex w-full justify-end gap-2 pt-1">
                  <Button variant="light" onClick={onClose}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="solid-primary"
                    onClick={() =>
                      setState({
                        step: "verify",
                        totpURI: state.totpURI,
                        backupCodes: state.backupCodes,
                      })
                    }
                  >
                    {t("account.security.twofa.setup.continue")}
                  </Button>
                </div>
              </div>
            ) : null}

            {state.step === "verify" ? (
              <div className="flex flex-col items-center gap-4">
                <div className="text-center">
                  <div className="text-[13px] font-medium text-foreground">
                    {t("account.security.twofa.setup.verifyTitle")}
                  </div>
                  <div className="mt-1 text-[12px] text-rv-mute-500">
                    {t("account.security.twofa.setup.verifyDesc")}
                  </div>
                </div>

                <OTPInput
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    if (verifyError) setVerifyError(null);
                  }}
                  onComplete={(v) => handleVerify(v)}
                  disabled={verifyBusy}
                />

                {verifyError ? (
                  <div role="alert" className="text-[12px] text-rv-danger">
                    {verifyError}
                  </div>
                ) : null}

                <div className="flex w-full justify-between gap-2 pt-1">
                  <Button
                    variant="light"
                    onClick={() =>
                      setState({
                        step: "connect",
                        totpURI: state.totpURI,
                        backupCodes: state.backupCodes,
                      })
                    }
                    disabled={verifyBusy}
                  >
                    {t("common.back")}
                  </Button>
                  <Button
                    variant="solid-primary"
                    onClick={() => handleVerify()}
                    disabled={verifyBusy || code.length !== 6}
                  >
                    {verifyBusy
                      ? t("common.saving", "Saving…")
                      : t("account.security.twofa.setup.verify")}
                  </Button>
                </div>
              </div>
            ) : null}

            {state.step === "codes" ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rv-warning" />
                  <div className="text-[12px] leading-relaxed text-foreground">
                    <div className="font-medium">
                      {t("account.security.twofa.recovery.saveTitle")}
                    </div>
                    <div className="mt-0.5 text-rv-mute-600">
                      {t("account.security.twofa.recovery.oneTimeNotice")}
                    </div>
                  </div>
                </div>

                <BackupCodesGrid codes={state.backupCodes} />

                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton
                    size="sm"
                    value={state.backupCodes.join("\n")}
                    label={t("account.security.twofa.recovery.copyAll")}
                    copiedLabel={t("account.security.twofa.recovery.copied")}
                  />
                  <Button
                    variant="flat"
                    onClick={() => downloadBackupCodes(state.backupCodes, email)}
                  >
                    <Download size={13} />
                    {t("account.security.twofa.recovery.download")}
                  </Button>
                </div>

                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2.5 text-[12px] text-foreground hover:border-rv-divider-strong">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-rv-accent-500"
                  />
                  <span>{t("account.security.twofa.recovery.ack")}</span>
                </label>

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    variant="solid-primary"
                    onClick={finish}
                    disabled={!acknowledged}
                  >
                    {t("account.security.twofa.setup.finish")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// =============================================================
// Disable confirmation dialog
// =============================================================

function DisableTwoFactorDialog({
  open,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.disable({});
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Failed to disable");
      return;
    }
    onConfirmed();
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rv-danger/15 text-rv-danger">
              <AlertTriangle size={18} />
            </div>
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("account.security.twofa.disable.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-rv-mute-600">
                {t("account.security.twofa.disable.body")}
              </Dialog.Description>
            </div>
          </div>

          {error ? (
            <div className="mx-5 mt-4 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
              {error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end gap-2 border-t border-rv-divider bg-rv-c2 px-5 py-3">
            <Button variant="light" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="solid-primary"
              onClick={confirm}
              disabled={busy}
              className="bg-rv-danger hover:bg-rv-danger/85"
            >
              {busy
                ? t("common.saving", "Saving…")
                : t("account.security.twofa.disable.confirm")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// =============================================================
// Regenerate recovery codes dialog
// =============================================================

function RegenerateCodesDialog({
  open,
  email,
  onClose,
}: {
  open: boolean;
  email: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"warn" | "show">("warn");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setPhase("warn");
      setCodes([]);
      setBusy(false);
      setError(null);
      setAcknowledged(false);
    }
  }, [open]);

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.generateBackupCodes({});
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.message ?? "Failed to generate codes");
      return;
    }
    setCodes(res.data.backupCodes);
    setPhase("show");
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[480px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rv-accent-500/15 text-rv-accent-500">
                <KeyRound size={17} />
              </div>
              <div>
                <Dialog.Title className="text-[15px] font-semibold">
                  {t("account.security.twofa.recovery.title")}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                  {phase === "warn"
                    ? t("account.security.twofa.recovery.regenerateSubtitle")
                    : t("account.security.twofa.recovery.saveSubtitle")}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
              disabled={busy}
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            {phase === "warn" ? (
              <>
                <div className="flex items-start gap-3 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rv-warning" />
                  <div className="text-[12px] leading-relaxed text-foreground">
                    <div className="font-medium">
                      {t("account.security.twofa.recovery.invalidatesTitle")}
                    </div>
                    <div className="mt-0.5 text-rv-mute-600">
                      {t("account.security.twofa.recovery.invalidatesBody")}
                    </div>
                  </div>
                </div>
                {error ? (
                  <div className="mt-3 text-[12px] text-rv-danger">{error}</div>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="light" onClick={onClose} disabled={busy}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="solid-primary"
                    onClick={regenerate}
                    disabled={busy}
                  >
                    {busy
                      ? t("common.saving", "Saving…")
                      : t("account.security.twofa.recovery.generate")}
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2.5">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rv-warning" />
                  <div className="text-[12px] leading-relaxed text-foreground">
                    <div className="font-medium">
                      {t("account.security.twofa.recovery.saveTitle")}
                    </div>
                    <div className="mt-0.5 text-rv-mute-600">
                      {t("account.security.twofa.recovery.oneTimeNotice")}
                    </div>
                  </div>
                </div>

                <BackupCodesGrid codes={codes} />

                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton
                    size="sm"
                    value={codes.join("\n")}
                    label={t("account.security.twofa.recovery.copyAll")}
                    copiedLabel={t("account.security.twofa.recovery.copied")}
                  />
                  <Button
                    variant="flat"
                    onClick={() => downloadBackupCodes(codes, email)}
                  >
                    <Download size={13} />
                    {t("account.security.twofa.recovery.download")}
                  </Button>
                </div>

                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2.5 text-[12px] text-foreground hover:border-rv-divider-strong">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-rv-accent-500"
                  />
                  <span>{t("account.security.twofa.recovery.ack")}</span>
                </label>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="solid-primary"
                    onClick={onClose}
                    disabled={!acknowledged}
                  >
                    {t("account.security.twofa.setup.finish")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// =============================================================
// Backup codes grid
// =============================================================

function BackupCodesGrid({ codes }: { codes: readonly string[] }) {
  return (
    <ol className="grid grid-cols-2 gap-1.5">
      {codes.map((c, idx) => (
        <li
          key={c}
          className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-2.5 py-2"
        >
          <span className="font-rv-mono text-[10px] text-rv-mute-500">
            {String(idx + 1).padStart(2, "0")}
          </span>
          <code className="select-all font-rv-mono text-[12px] tracking-[0.05em] text-foreground">
            {c}
          </code>
        </li>
      ))}
    </ol>
  );
}

// =============================================================
// 2FA section — empty (off) + enabled rows
// =============================================================

function TwoFactorEmptyState({ onSetUp }: { onSetUp: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-rv-divider bg-rv-c2/40 p-5 sm:flex-row sm:items-center">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-rv-c2 text-rv-mute-600">
        <Shield size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">
          {t("account.security.twofa.empty.title")}
        </div>
        <div className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
          {t("account.security.twofa.empty.body")}
        </div>
        <div className="mt-1.5 text-[11px] text-rv-mute-500">
          {t("account.security.twofa.empty.apps")}
        </div>
      </div>
      <Button variant="solid-primary" onClick={onSetUp} className="shrink-0">
        <Smartphone size={13} />
        {t("account.security.twofa.empty.cta")}
      </Button>
    </div>
  );
}

function TwoFactorEnabledRow({ onDisable }: { onDisable: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-rv-success/25 bg-rv-success/5 p-4 sm:flex-row sm:items-center">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rv-success/15 text-rv-success">
        <ShieldCheck size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-foreground">
          {t("account.security.twofa.enabled.title")}
          <span className="rounded bg-rv-success/15 px-1.5 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-success">
            {t("common.active")}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] text-rv-mute-600">
          {t("account.security.twofa.enabled.body")}
        </div>
      </div>
      <Button variant="light" onClick={onDisable} className="text-rv-danger hover:text-rv-danger">
        {t("account.security.twofa.authenticator.disable")}
      </Button>
    </div>
  );
}

function RecoveryCodesRow({ onRegenerate }: { onRegenerate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-col items-start gap-3 rounded-lg border border-rv-divider bg-rv-c2/40 p-4 sm:flex-row sm:items-center">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rv-c2 text-rv-mute-700">
        <KeyRound size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">
          {t("account.security.twofa.recovery.title")}
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-rv-mute-500">
          {t("account.security.twofa.recovery.desc")}
        </div>
      </div>
      <Button variant="flat" onClick={onRegenerate}>
        {t("account.security.twofa.recovery.regenerate")}
      </Button>
    </div>
  );
}

// =============================================================
// Page
// =============================================================

function SecurityPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: sessions = [], isLoading } = useMySessions();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  const twoFactorEnabled = me?.twoFactorEnabled ?? false;
  const email = me?.email ?? "";
  const otherSessions = sessions.filter((s) => !s.current).length;

  const refreshMe = useCallback(() => {
    // Better Auth re-issues the session cookie on enable/disable,
    // so invalidate the /me query to pick up the new flag without
    // a hard reload.
    qc.invalidateQueries({ queryKey: ["me"] });
    qc.invalidateQueries({ queryKey: ["me", "sessions"] });
  }, [qc]);

  return (
    <AccountShell active="security">
      <AccountPageHeader
        title={t("account.security.title")}
        description={t("account.security.subtitle")}
      />

      <SectionCard
        title={t("account.security.twofa.title")}
        description={t("account.security.twofa.subtitle")}
      >
        {twoFactorEnabled ? (
          <>
            <TwoFactorEnabledRow onDisable={() => setDisableOpen(true)} />
            <RecoveryCodesRow onRegenerate={() => setRegenOpen(true)} />
          </>
        ) : (
          <TwoFactorEmptyState onSetUp={() => setSetupOpen(true)} />
        )}
      </SectionCard>

      <SectionCard
        title={t("account.security.sessions.title")}
        description={t("account.security.sessions.subtitle")}
        meta={t("account.security.sessions.count", { count: sessions.length })}
        footer={
          <Button
            variant="flat"
            onClick={() => revokeOthers.mutate()}
            disabled={revokeOthers.isPending || otherSessions === 0}
          >
            {revokeOthers.isPending
              ? t("common.saving", "Saving…")
              : t("account.security.sessions.signOutAll")}
          </Button>
        }
      >
        {isLoading && sessions.length === 0 ? (
          <div className="py-3 text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-3 text-[12px] text-rv-mute-500">
            {t(
              "account.security.sessions.empty",
              "No active sessions besides this one.",
            )}
          </div>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              device={describeDevice(s.userAgent)}
              meta={describeMeta(s)}
              current={s.current}
              onRevoke={() => revokeSession.mutate(s.id)}
            />
          ))
        )}
      </SectionCard>

      <TwoFactorSetupDialog
        open={setupOpen}
        email={email}
        onClose={() => setSetupOpen(false)}
        onCompleted={refreshMe}
      />
      <DisableTwoFactorDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirmed={refreshMe}
      />
      <RegenerateCodesDialog
        open={regenOpen}
        email={email}
        onClose={() => setRegenOpen(false)}
      />
    </AccountShell>
  );
}
