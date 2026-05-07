import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  ConnectionRow,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";

export const Route = createFileRoute("/_authed/account/connected")({
  component: ConnectedPage,
});

type Provider = {
  id: string;
  glyph: string;
  bg: string;
  metaKey: string;
  primary?: boolean;
  actionKey?: "connect" | "configure";
};

const PROVIDERS: ReadonlyArray<Provider> = [
  { id: "google", glyph: "Go", bg: "#FBBC04", primary: true, metaKey: "google.connected" },
  { id: "github", glyph: "Gi", bg: "#24292F", metaKey: "github.connected" },
  { id: "apple", glyph: "Ap", bg: "#0A0A0A", metaKey: "apple.disconnected", actionKey: "connect" },
  { id: "sso", glyph: "SS", bg: "#3B82F6", metaKey: "sso.disconnected", actionKey: "configure" },
];

const APPS: ReadonlyArray<{ id: string; glyph: string; bg: string }> = [
  { id: "linear", glyph: "Li", bg: "#5E6AD2" },
  { id: "zapier", glyph: "Za", bg: "#FF4F00" },
  { id: "raycast", glyph: "Ra", bg: "#FF6363" },
];

function ConnectedPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="connected">
      <AccountPageHeader
        title={t("account.connected.title")}
        description={t("account.connected.subtitle")}
      />

      <SectionCard
        title={t("account.connected.providers.title")}
        description={t("account.connected.providers.subtitle")}
      >
        {PROVIDERS.map((p) => (
          <ConnectionRow
            key={p.id}
            glyph={p.glyph}
            glyphStyle={{ background: p.bg }}
            name={t(`account.connected.providers.items.${p.id}.name`)}
            meta={t(`account.connected.providers.items.${p.metaKey}`)}
            primary={p.primary}
            primaryLabel={t("account.connected.providers.primary")}
            action={
              <Button variant="flat">
                {p.actionKey
                  ? t(`account.connected.providers.actions.${p.actionKey}`)
                  : t("account.connected.providers.actions.disconnect")}
              </Button>
            }
          />
        ))}
      </SectionCard>

      <SectionCard
        title={t("account.connected.apps.title")}
        description={t("account.connected.apps.subtitle")}
      >
        {APPS.map((a) => (
          <ConnectionRow
            key={a.id}
            glyph={a.glyph}
            glyphStyle={{ background: a.bg }}
            name={t(`account.connected.apps.items.${a.id}.name`)}
            meta={t(`account.connected.apps.items.${a.id}.meta`)}
            action={<Button variant="light">{t("account.connected.apps.revoke")}</Button>}
          />
        ))}
      </SectionCard>
    </AccountShell>
  );
}
