import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  AccountToggleRow,
  SectionCard,
} from "../../../components/account";
import { NativeSelect } from "../../../ui/native-select";
import { DeviceList } from "../../../components/notifications/device-list";
import { EventToggleList } from "../../../components/notifications/event-toggle-list";
import { useProjects } from "../../../lib/hooks/useProjects";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "../../../lib/hooks/useNotificationPreferences";

// =============================================================
// /account/notifications — per-user notification preferences
// =============================================================
//
// Three sections per spec §7.3:
//   1. Channel masters (email + push) + locale + timezone.
//   2. Registered push devices (read-only list with revoke).
//   3. Per-project event overrides — project picker drives the
//      EventToggleList state. Forced events render disabled with
//      a lock icon (component handles the wiring); the server
//      also rejects writes for them as defence in depth.
//
// We drop the old slack/marketing toggles entirely. Slack lives
// behind the integrations workspace; marketing email is a
// product-marketing concern that doesn't belong on this page.

export const Route = createFileRoute("/_authed/account/notifications")({
  component: NotificationsPage,
});

function NotificationsPage() {
  const { t } = useTranslation();
  const projects = useProjects();
  const projectOptions = useMemo(
    () =>
      (projects.data ?? []).map((p) => ({
        value: p.id,
        label: p.name,
      })),
    [projects.data],
  );

  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const effectiveProjectId =
    projectId ?? projectOptions[0]?.value ?? undefined;

  const prefs = useNotificationPreferences(effectiveProjectId);
  const update = useUpdateNotificationPreferences();

  const channels = prefs.data?.channels ?? {
    email: true,
    push: true,
    locale: "en",
    timezone: "UTC",
  };

  return (
    <AccountShell active="notifications">
      <AccountPageHeader
        title={t("notifications.prefs.title", "Notifications")}
        description={t(
          "notifications.prefs.description",
          "Control which alerts reach you, and on which channel.",
        )}
      />

      <div className="flex flex-col gap-6">
        {/* 1) Channel masters + locale/tz link */}
        <SectionCard
          title={t("notifications.prefs.channels.title", "Channels")}
        >
          <AccountToggleRow
            title={t("notifications.prefs.channels.email", "Email")}
            description={t(
              "notifications.prefs.channels.emailDesc",
              "Required security notifications still send even when this is off.",
            )}
            checked={channels.email}
            onChange={(v) =>
              update.mutate({ scope: "global", channels: { email: v } })
            }
          />
          <AccountToggleRow
            title={t("notifications.prefs.channels.push", "Push")}
            description={t(
              "notifications.prefs.channels.pushDesc",
              "Mobile alerts on devices listed below.",
            )}
            checked={channels.push}
            onChange={(v) =>
              update.mutate({ scope: "global", channels: { push: v } })
            }
          />
          <p className="mt-3 text-[12px] text-rv-mute-500">
            {t("notifications.prefs.channels.localeHint", "Locale + timezone")}
            :{" "}
            <Link to="/account/profile" className="underline">
              {channels.locale} · {channels.timezone}
            </Link>
          </p>
        </SectionCard>

        {/* 2) Push devices */}
        <SectionCard
          title={t(
            "notifications.prefs.devices.title",
            "Registered devices",
          )}
        >
          <DeviceList />
        </SectionCard>

        {/* 3) Per-event toggles, scoped to the picked project */}
        <SectionCard
          title={t(
            "notifications.prefs.events.title",
            "Per-event preferences",
          )}
        >
          {projectOptions.length === 0 ? (
            <p className="text-[12px] text-rv-mute-500">
              {t(
                "notifications.prefs.events.noProjects",
                "Create a project to manage per-event preferences.",
              )}
            </p>
          ) : (
            <>
              <div className="mb-4">
                <NativeSelect
                  value={effectiveProjectId ?? ""}
                  onChange={(e) => setProjectId(e.target.value)}
                  aria-label={t(
                    "notifications.prefs.events.projectPicker",
                    "Project",
                  )}
                >
                  {projectOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <EventToggleList
                mode="user"
                projectDefaults={prefs.data?.projectDefaults ?? {}}
                userOverrides={prefs.data?.userOverrides ?? {}}
                disabled={update.isPending}
                onChange={(eventKey, next) => {
                  if (!effectiveProjectId) return;
                  update.mutate({
                    scope: "project",
                    projectId: effectiveProjectId,
                    overrides: { [eventKey]: next },
                  });
                }}
              />
            </>
          )}
        </SectionCard>
      </div>
    </AccountShell>
  );
}
