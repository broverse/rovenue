import { useMemo } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  EVENT_CATALOG,
  type NotificationEventDescriptor,
} from "@rovenue/shared/notifications";
import { Switch } from "../../ui/switch";

// =============================================================
// EventToggleList — per-event on/off matrix
// =============================================================
//
// Used by both the per-user preferences page (mode="user") and
// the per-project defaults editor (mode="project-defaults"). The
// two modes differ only in the source-of-truth label shown
// alongside the toggle ("default" / "custom" vs nothing).
//
// Forced-channel events render with a Lock icon, disabled
// toggle, and a tooltip — the server rejects writes for them
// anyway, but the disabled UI explains *why*.

type Mode = "user" | "project-defaults";

interface EventToggleListProps {
  mode: Mode;
  /** Project-scoped defaults (server source-of-truth in user mode). */
  projectDefaults: Record<string, boolean>;
  /** Per-user overrides (user mode only). */
  userOverrides?: Record<string, boolean>;
  /** Persists a single key. Receives the eventKey + new value. */
  onChange: (eventKey: string, next: boolean) => void;
  /** Disable the whole list (e.g. while saving). */
  disabled?: boolean;
}

interface EventEntry {
  key: string;
  descriptor: NotificationEventDescriptor;
}

function groupByCategory(): Record<string, EventEntry[]> {
  const out: Record<string, EventEntry[]> = {};
  for (const [key, descriptor] of Object.entries(EVENT_CATALOG)) {
    const cat = descriptor.category;
    (out[cat] ||= []).push({ key, descriptor });
  }
  return out;
}

function resolveEnabled(
  mode: Mode,
  descriptor: NotificationEventDescriptor,
  projectDefaults: Record<string, boolean>,
  userOverrides: Record<string, boolean>,
  key: string,
): { enabled: boolean; source: "user" | "project" | "catalog" } {
  if (mode === "project-defaults") {
    return key in projectDefaults
      ? { enabled: projectDefaults[key] !== false, source: "project" }
      : { enabled: descriptor.defaultEnabled, source: "catalog" };
  }
  if (key in userOverrides) {
    return { enabled: userOverrides[key] !== false, source: "user" };
  }
  if (key in projectDefaults) {
    return { enabled: projectDefaults[key] !== false, source: "project" };
  }
  return { enabled: descriptor.defaultEnabled, source: "catalog" };
}

export function EventToggleList({
  mode,
  projectDefaults,
  userOverrides = {},
  onChange,
  disabled,
}: EventToggleListProps) {
  const { t } = useTranslation();
  const groups = useMemo(groupByCategory, []);

  return (
    <div className="flex flex-col gap-6">
      {Object.entries(groups).map(([category, events]) => (
        <section key={category}>
          <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-rv-mute-500">
            {t(
              `notifications.categories.${category}`,
              category[0]!.toUpperCase() + category.slice(1),
            )}
          </h3>
          <div className="divide-y divide-rv-divider rounded-md border border-rv-divider bg-rv-c1">
            {events.map(({ key, descriptor }) => {
              const forced =
                descriptor.forcedChannels &&
                descriptor.forcedChannels.length > 0;
              const { enabled, source } = resolveEnabled(
                mode,
                descriptor,
                projectDefaults,
                userOverrides,
                key,
              );
              return (
                <div
                  key={key}
                  className="flex items-center justify-between px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[13px] text-foreground">
                        {t(`notifications.events.${key}.title`, key)}
                      </p>
                      {forced ? (
                        <span
                          title={t(
                            "notifications.events.forcedTooltip",
                            "Required notification — cannot be turned off.",
                          )}
                          className="inline-flex items-center text-rv-mute-500"
                        >
                          <Lock size={11} aria-hidden />
                        </span>
                      ) : null}
                      {mode === "user" && source !== "catalog" ? (
                        <span className="ml-1 rounded bg-rv-c3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rv-mute-600">
                          {source === "user"
                            ? t("notifications.source.custom", "Custom")
                            : t("notifications.source.default", "Default")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Switch
                    checked={forced ? true : enabled}
                    disabled={disabled || forced}
                    onChange={(next) => onChange(key, next)}
                    ariaLabel={key}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
