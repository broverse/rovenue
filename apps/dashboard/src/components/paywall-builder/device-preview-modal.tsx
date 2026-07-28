import { useEffect, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { Smartphone, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { CopyButton } from "../../ui/copy-button";
import { CodeBlock } from "../../ui/code-block";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { PaywallBuilderApi, type PreviewSessionDto } from "../../lib/services/paywall-builder-api";

type Props = { onClose: () => void };

type SnippetTab = "swift" | "kotlin" | "reactNative";

/** How often the countdown re-renders. Cosmetic only — the server, not the
 * client clock, is authoritative for actual expiry. */
const COUNTDOWN_TICK_MS = 1000;

/** QR render options — mirrors `useQrDataUrl` in account/security.tsx so
 * every client-rendered QR in the dashboard looks the same. */
const QR_WIDTH_PX = 220;
const QR_MARGIN = 1;
const QR_DARK_COLOR = "#0F0F12";
const QR_LIGHT_COLOR = "#FFFFFF";

function swiftSnippet(token: string): string {
  return [
    "RovenuePaywallPreviewView(",
    `    token: "${token}",`,
    "    onClose: { /* dismiss */ },",
    "    onUrl: { url in /* open url */ }",
    ")",
  ].join("\n");
}

function kotlinSnippet(token: string): string {
  return [
    "val previewView = RovenuePaywallPreviewView(context)",
    "container.addView(previewView)",
    `previewView.bindPreview("${token}", PaywallViewOptions(onClose = { /* dismiss */ }))`,
  ].join("\n");
}

/** mm:ss countdown for a millisecond duration, floored at 0. */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * P9 on-device paywall preview (§6.16). Mints a short-lived preview session
 * on open (draft access for a physical device, via Task 2's mint endpoint),
 * renders it as a scannable QR + copyable token/URL, and lets the author
 * end the session early. While this modal is open the VM's
 * `previewSessionActive` flag is true, which makes edits flush to the
 * server on a short debounce instead of the ordinary 30s autosave throttle
 * (see `PaywallBuilderViewModel.previewFastFlush`) — the whole point of a
 * live device preview is that edits show up on it quickly.
 */
export const DevicePreviewModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const api = useService(PaywallBuilderApi);
  const { t } = useTranslation();

  const [session, setSession] = useState<PreviewSessionDto | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<SnippetTab>("swift");

  // Mint exactly once, on open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const created = await api.createPreviewSession(vm.projectId, vm.paywallId);
        if (cancelled) return;
        setSession(created);
        vm.setPreviewSessionActive(true);
      } catch (err) {
        if (cancelled) return;
        setMintError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the QR client-side from `qrPayload` once the session exists.
  useEffect(() => {
    if (!session) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(session.qrPayload, {
      errorCorrectionLevel: "M",
      margin: QR_MARGIN,
      width: QR_WIDTH_PX,
      color: { dark: QR_DARK_COLOR, light: QR_LIGHT_COLOR },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Expiry countdown tick.
  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(id);
  }, [session]);

  const remainingMs = session ? new Date(session.expiresAt).getTime() - now : 0;
  const expired = session != null && remainingMs <= 0;

  async function handleEndSession() {
    if (session) {
      try {
        await api.revokePreviewSession(vm.projectId, vm.paywallId, session.sessionId);
      } catch {
        // Best-effort: the session will expire on its own regardless, and
        // the author closing the modal is what matters locally.
      }
    }
    vm.setPreviewSessionActive(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={() => void handleEndSession()}
    >
      <div
        className="flex max-h-[88vh] w-[min(560px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <Smartphone size={16} className="text-rv-mute-500" />
              {t("paywalls.builder.devicePreview.title", "Preview on a device")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.devicePreview.subtitle",
                "Scan the QR code with the Rovenue app to preview this draft live on a physical device.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleEndSession()}
            title={t("paywalls.builder.devicePreview.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {mintError ? (
            <div className="py-6 text-center text-[13px] text-rv-danger">
              {t("paywalls.builder.devicePreview.mintFailed", "Could not start a preview session. Try again.")}
            </div>
          ) : !session ? (
            <div className="py-6 text-center text-[13px] text-rv-mute-500">
              {t("paywalls.builder.devicePreview.minting", "Starting preview session…")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col items-center gap-2">
                {qrDataUrl && (
                  <img
                    src={qrDataUrl}
                    width={QR_WIDTH_PX}
                    height={QR_WIDTH_PX}
                    alt={t(
                      "paywalls.builder.devicePreview.qrAlt",
                      "QR code linking to this preview session",
                    )}
                    className="rounded-md border border-rv-divider"
                  />
                )}
                <div
                  className={cn(
                    "font-rv-mono text-[11px]",
                    expired ? "text-rv-danger" : "text-rv-mute-500",
                  )}
                >
                  {expired
                    ? t("paywalls.builder.devicePreview.expired", "This preview session has expired.")
                    : t("paywalls.builder.devicePreview.expiresIn", "Expires in {{time}}", {
                        time: formatCountdown(remainingMs),
                      })}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-16 flex-shrink-0 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                    {t("paywalls.builder.devicePreview.tokenLabel", "Token")}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-rv-mono text-[11px] text-foreground">
                    {session.token}
                  </span>
                  <CopyButton
                    size="xs"
                    value={session.token}
                    label={t("paywalls.builder.devicePreview.copy", "Copy")}
                    copiedLabel={t("paywalls.builder.devicePreview.copied", "Copied")}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16 flex-shrink-0 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                    {t("paywalls.builder.devicePreview.urlLabel", "Preview URL")}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-rv-mono text-[11px] text-foreground">
                    {session.previewUrl}
                  </span>
                  <CopyButton
                    size="xs"
                    value={session.previewUrl}
                    label={t("paywalls.builder.devicePreview.copy", "Copy")}
                    copiedLabel={t("paywalls.builder.devicePreview.copied", "Copied")}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex gap-1 border-b border-rv-divider">
                  {(
                    [
                      { id: "swift" as const, label: t("paywalls.builder.devicePreview.tabSwift", "Swift") },
                      { id: "kotlin" as const, label: t("paywalls.builder.devicePreview.tabKotlin", "Kotlin") },
                      {
                        id: "reactNative" as const,
                        label: t("paywalls.builder.devicePreview.tabReactNative", "React Native"),
                      },
                    ]
                  ).map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      className={cn(
                        "cursor-pointer rounded-t-md border-b-2 px-3 py-1.5 text-[12px] font-medium transition",
                        activeTab === id
                          ? "border-rv-accent-500 text-foreground"
                          : "border-transparent text-rv-mute-500 hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {activeTab === "swift" && (
                  <CodeBlock code={swiftSnippet(session.token)} language="swift" />
                )}
                {activeTab === "kotlin" && (
                  <CodeBlock code={kotlinSnippet(session.token)} language="kotlin" />
                )}
                {activeTab === "reactNative" && (
                  <div className="rounded-md border border-rv-divider bg-rv-c2 px-3.5 py-3 text-[12px] text-rv-mute-600">
                    {t(
                      "paywalls.builder.devicePreview.reactNativeComingSoon",
                      "React Native preview support is coming soon.",
                    )}
                  </div>
                )}
              </div>

              <p className="text-[11px] text-rv-mute-500">
                {t(
                  "paywalls.builder.devicePreview.activeHint",
                  "Edits made while this session is open save within a couple of seconds so the device stays in sync.",
                )}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-rv-divider px-5 py-3">
          <button
            type="button"
            onClick={() => void handleEndSession()}
            className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
          >
            {t("paywalls.builder.devicePreview.endSession", "End session")}
          </button>
        </div>
      </div>
    </div>
  );
});
