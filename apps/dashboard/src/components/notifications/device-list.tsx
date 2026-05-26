import { Smartphone, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  usePushDevices,
  useRevokePushDevice,
} from "../../lib/hooks/usePushDevices";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const day = 24 * 60 * 60_000;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function DeviceList() {
  const { t } = useTranslation();
  const { data: devices = [], isLoading } = usePushDevices();
  const revoke = useRevokePushDevice();

  if (isLoading) {
    return (
      <p className="text-[12px] text-rv-mute-500">
        {t("notifications.devices.loading", "Loading devices…")}
      </p>
    );
  }

  if (devices.length === 0) {
    return (
      <p className="text-[12px] text-rv-mute-500">
        {t(
          "notifications.devices.empty",
          "No push devices registered. Sign in on iOS or Android to add one.",
        )}
      </p>
    );
  }

  return (
    <div className="divide-y divide-rv-divider rounded-md border border-rv-divider bg-rv-c1">
      {devices.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-3 px-3 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-rv-mute-500">
              <Smartphone size={14} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] text-foreground">
                {d.platform === "ios" ? "iOS" : "Android"} · {d.appBundleId}
              </p>
              <p className="text-[11px] text-rv-mute-500">
                {t("notifications.devices.lastSeen", "Last seen")}{" "}
                {relativeTime(d.lastSeenAt)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => revoke.mutate(d.id)}
            disabled={revoke.isPending}
            aria-label={t("notifications.devices.revoke", "Revoke device")}
            className="rounded p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-rv-danger disabled:opacity-50"
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
