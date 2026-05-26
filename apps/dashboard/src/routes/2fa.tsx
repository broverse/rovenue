import { useEffect, useState } from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OTPInput } from "../ui/otp-input";
import { cn } from "../lib/cn";
import { authClient } from "../lib/auth";

export const Route = createFileRoute("/2fa")({
  component: TwoFactorVerifyRoute,
});

// =============================================================
// /2fa — sign-in TOTP / backup-code verify page
// =============================================================
//
// Better Auth's twoFactor plugin redirects here whenever a sign-
// in response carries `twoFactorRedirect: true` (i.e. the OAuth
// roundtrip succeeded but 2FA gates the actual session). The
// only path forward is a valid 6-digit TOTP or a backup code —
// nothing else is exposed.

type Mode = "totp" | "backup";

function normalizeBackupCode(raw: string): string {
  // Backup codes are 10 alphanumeric chars rendered as XXXXX-XXXXX.
  // Accept either form and re-insert the hyphen so the request
  // body always matches what Better Auth issued.
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return cleaned.length > 5
    ? `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`
    : cleaned;
}

function TwoFactorVerifyRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear stale error the moment the user starts editing again
  // so the red OTP slots release after a failed attempt.
  useEffect(() => {
    if (error && code.length > 0) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const submit = async (override?: string) => {
    const raw = override ?? code;
    if (busy) return;
    setBusy(true);
    setError(null);
    const res =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp({
            code: raw.trim(),
            trustDevice,
          })
        : await authClient.twoFactor.verifyBackupCode({
            code: normalizeBackupCode(raw),
          });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t("auth.twofa.invalid"));
      return;
    }
    navigate({ to: "/" });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setCode("");
    setError(null);
  };

  const totpReady = mode === "totp" && code.length === 6;
  const backupReady = mode === "backup" && code.replace(/-/g, "").length === 10;
  const canSubmit = (totpReady || backupReady) && !busy;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-rv-bg p-6">
      {/* Subtle radial gradient backdrop so the card lifts off the
          page without competing with the OTP grid. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(139,92,246,0.08),transparent_60%)]"
      />

      <div className="relative w-full max-w-md">
        <div className="rounded-2xl border border-rv-divider bg-rv-c1 p-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-9">
          {/* Mode-aware brand mark */}
          <div className="mb-6 flex justify-center">
            <div
              className={cn(
                "flex h-14 w-14 items-center justify-center rounded-full border transition-colors",
                mode === "totp"
                  ? "border-rv-accent-500/30 bg-rv-accent-500/10 text-rv-accent-500"
                  : "border-rv-warning/30 bg-rv-warning/10 text-rv-warning",
              )}
            >
              {mode === "totp" ? (
                <ShieldCheck size={26} />
              ) : (
                <KeyRound size={24} />
              )}
            </div>
          </div>

          <div className="mb-6 text-center">
            <h1 className="text-[18px] font-semibold tracking-tight text-foreground">
              {mode === "totp"
                ? t("auth.twofa.title")
                : t("auth.twofa.backupTitle")}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-rv-mute-500">
              {mode === "totp"
                ? t("auth.twofa.subtitle")
                : t("auth.twofa.backupSubtitle")}
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit();
            }}
            className="space-y-4"
          >
            {mode === "totp" ? (
              <OTPInput
                value={code}
                onChange={setCode}
                onComplete={(v) => submit(v)}
                disabled={busy}
                invalid={!!error}
                ariaLabel={t("auth.twofa.title")}
              />
            ) : (
              <Input
                mono
                autoFocus
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="XXXXX-XXXXX"
                value={code}
                onChange={(e) => setCode(normalizeBackupCode(e.target.value))}
                className={cn(
                  "h-12 text-center text-[16px] tracking-[0.3em]",
                  error && "border-rv-danger/60 focus:border-rv-danger",
                )}
                disabled={busy}
              />
            )}

            <div className="min-h-[18px] text-center">
              {error ? (
                <div role="alert" className="text-[12px] text-rv-danger">
                  {error}
                </div>
              ) : null}
            </div>

            {mode === "totp" ? (
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2 text-[12px] text-foreground transition hover:border-rv-divider-strong">
                <input
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="h-3.5 w-3.5 accent-rv-accent-500"
                />
                <span className="flex-1">{t("auth.twofa.trustDevice")}</span>
                <span className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                  {t("auth.twofa.trustDeviceTag")}
                </span>
              </label>
            ) : null}

            <Button
              type="submit"
              variant="solid-primary"
              size="md"
              disabled={!canSubmit}
              className="w-full justify-center"
            >
              {busy ? t("common.saving", "Saving…") : t("auth.twofa.verify")}
            </Button>
          </form>

          <div className="mt-5 border-t border-rv-divider pt-4 text-center">
            <button
              type="button"
              onClick={() => switchMode(mode === "totp" ? "backup" : "totp")}
              className="text-[12px] font-medium text-rv-mute-600 transition hover:text-foreground"
            >
              {mode === "totp"
                ? t("auth.twofa.useBackup")
                : t("auth.twofa.useTotp")}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center">
          <Link
            to="/login"
            search={{ error: undefined }}
            className="inline-flex items-center gap-1.5 text-[12px] text-rv-mute-500 transition hover:text-foreground"
          >
            <ArrowLeft size={12} />
            {t("auth.twofa.backToSignIn")}
          </Link>
        </div>
      </div>
    </div>
  );
}
