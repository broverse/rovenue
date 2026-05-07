import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
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

export const Route = createFileRoute("/_authed/account/security")({
  component: SecurityPage,
});

type SessionDef = { id: string; deviceKey: string; metaKey: string; current?: boolean };

const SESSIONS: ReadonlyArray<SessionDef> = [
  { id: "mac-chrome", deviceKey: "macChrome", metaKey: "macChrome", current: true },
  { id: "iphone", deviceKey: "iphone", metaKey: "iphone" },
  { id: "ipad", deviceKey: "ipad", metaKey: "ipad" },
  { id: "linux", deviceKey: "linux", metaKey: "linux" },
];

function SecurityPage() {
  const { t } = useTranslation();

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
        meta={t("account.security.sessions.count", { count: SESSIONS.length })}
        footer={<Button variant="flat">{t("account.security.sessions.signOutAll")}</Button>}
      >
        {SESSIONS.map((s) => (
          <SessionRow
            key={s.id}
            device={t(`account.security.sessions.devices.${s.deviceKey}.device`)}
            meta={t(`account.security.sessions.devices.${s.metaKey}.meta`)}
            current={s.current}
          />
        ))}
      </SectionCard>
    </AccountShell>
  );
}
