import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { MySession } from "@rovenue/shared";
import {
  AccountPageHeader,
  AccountShell,
  AccountToggleRow,
  Field,
  FieldRow,
  SectionCard,
  SessionRow,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import {
  useMySessions,
  useRevokeSession,
} from "../../../lib/hooks/useMySessions";

export const Route = createFileRoute("/_authed/account/security")({
  component: SecurityPage,
});

// =============================================================
// userAgent → "Browser on OS" parser
// =============================================================
//
// Intentionally minimal — we hit the common cases (Chrome / Safari
// / Firefox / Edge on macOS / Windows / iOS / Android / Linux)
// and fall back to a generic "Unknown device" rather than pulling
// in ua-parser-js for a single screen.

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
  // Order matters — Edge/Chrome both report "Chrome", and Safari's
  // UA contains "Safari" alongside other browsers, so test the
  // more specific tokens first.
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

function SecurityPage() {
  const { t } = useTranslation();
  const { data: sessions = [], isLoading } = useMySessions();
  const revokeSession = useRevokeSession();

  return (
    <AccountShell active="security">
      <AccountPageHeader
        title={t("account.security.title")}
        description={t("account.security.subtitle")}
      />

      <SectionCard
        title={t("account.security.password.title")}
        description={t("account.security.password.subtitle")}
        meta={t("account.security.password.lastChanged", { count: 47 })}
        footer={
          <Button variant="solid-primary">{t("account.security.password.update")}</Button>
        }
      >
        <Field label={t("account.security.password.current")}>
          <Input type="password" placeholder="••••••••••••" />
        </Field>
        <FieldRow>
          <Field label={t("account.security.password.new")}>
            <Input type="password" />
          </Field>
          <Field label={t("account.security.password.confirm")}>
            <Input type="password" />
          </Field>
        </FieldRow>
      </SectionCard>

      <SectionCard
        title={t("account.security.twofa.title")}
        description={t("account.security.twofa.subtitle")}
      >
        <AccountToggleRow
          title={
            <>
              {t("account.security.twofa.authenticator.title")}
              <span className="rounded bg-rv-success/15 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-success">
                {t("common.active").toLowerCase()}
              </span>
            </>
          }
          description={t("account.security.twofa.authenticator.desc")}
          right={<Button variant="flat">{t("account.security.twofa.reconfigure")}</Button>}
        />
        <AccountToggleRow
          title={t("account.security.twofa.hardware.title")}
          description={t("account.security.twofa.hardware.desc")}
          right={
            <Button variant="flat">
              <Plus size={13} />
              {t("account.security.twofa.hardware.add")}
            </Button>
          }
        />
        <AccountToggleRow
          title={t("account.security.twofa.sms.title")}
          description={t("account.security.twofa.sms.desc", { phone: "+1 (415) 555-0188" })}
          checked
          onChange={() => undefined}
        />
        <AccountToggleRow
          title={t("account.security.twofa.recovery.title")}
          description={t("account.security.twofa.recovery.desc", { remaining: 8 })}
          right={<Button variant="flat">{t("account.security.twofa.recovery.view")}</Button>}
        />
      </SectionCard>

      <SectionCard
        title={t("account.security.sessions.title")}
        description={t("account.security.sessions.subtitle")}
        meta={t("account.security.sessions.count", { count: sessions.length })}
        footer={
          <Button variant="flat">
            {t("account.security.sessions.signOutAll")}
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
    </AccountShell>
  );
}
