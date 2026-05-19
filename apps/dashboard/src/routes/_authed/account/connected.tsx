import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  ConnectionRow,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { authClient } from "../../../lib/auth";
import {
  useDisconnectAccount,
  useMyAccounts,
} from "../../../lib/hooks/useMyAccounts";

export const Route = createFileRoute("/_authed/account/connected")({
  component: ConnectedPage,
});

// =============================================================
// Provider catalogue
// =============================================================
//
// The backend only configures github + google today. Apple / SSO
// rows are kept as "coming soon" placeholders so the existing
// design copy doesn't break — `enabled: false` rows render with
// a disabled action button.

interface ProviderDef {
  id: string;
  glyph: string;
  bg: string;
  /** When false, the provider isn't wired server-side yet. */
  enabled: boolean;
}

const PROVIDERS: ReadonlyArray<ProviderDef> = [
  { id: "google", glyph: "Go", bg: "#FBBC04", enabled: true },
  { id: "github", glyph: "Gi", bg: "#24292F", enabled: true },
  { id: "apple", glyph: "Ap", bg: "#0A0A0A", enabled: false },
  { id: "sso", glyph: "SS", bg: "#3B82F6", enabled: false },
];

// Apps section is purely a marketing placeholder for now — no
// backend, kept on mock so the page composition still reads.
const APPS: ReadonlyArray<{ id: string; glyph: string; bg: string }> = [
  { id: "linear", glyph: "Li", bg: "#5E6AD2" },
  { id: "zapier", glyph: "Za", bg: "#FF4F00" },
  { id: "raycast", glyph: "Ra", bg: "#FF6363" },
];

function ConnectedPage() {
  const { t } = useTranslation();
  const { data: accounts = [] } = useMyAccounts();
  const disconnect = useDisconnectAccount();

  const linkedByProvider = useMemo(() => {
    const map = new Map<string, (typeof accounts)[number]>();
    for (const a of accounts) map.set(a.providerId, a);
    return map;
  }, [accounts]);

  const handleConnect = async (provider: string) => {
    // Better Auth's social sign-in flow re-uses the same redirect
    // dance as the login screen. Pointing the callback back at
    // this page lets the user see the new row appear in place.
    await authClient.signIn.social({
      provider: provider as "github" | "google",
      callbackURL: `${window.location.origin}/account/connected`,
    });
  };

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
        {PROVIDERS.map((p) => {
          const linked = linkedByProvider.get(p.id);
          const isLinked = Boolean(linked);
          const meta = isLinked
            ? t(
                "account.connected.providers.linkedAt",
                "Linked {{date}}",
                { date: new Date(linked!.createdAt).toLocaleDateString() },
              )
            : p.enabled
              ? t("account.connected.providers.notConnected", "Not connected")
              : t(
                  "account.connected.providers.unavailable",
                  "Not available in this deployment",
                );

          let action: React.ReactNode;
          if (!p.enabled) {
            action = (
              <Button variant="flat" disabled>
                {t("account.connected.providers.actions.connect")}
              </Button>
            );
          } else if (isLinked) {
            action = (
              <Button
                variant="flat"
                onClick={() => disconnect.mutate(p.id)}
                disabled={disconnect.isPending}
              >
                {t("account.connected.providers.actions.disconnect")}
              </Button>
            );
          } else {
            action = (
              <Button variant="flat" onClick={() => handleConnect(p.id)}>
                {t("account.connected.providers.actions.connect")}
              </Button>
            );
          }

          return (
            <ConnectionRow
              key={p.id}
              glyph={p.glyph}
              glyphStyle={{ background: p.bg }}
              name={t(`account.connected.providers.items.${p.id}.name`)}
              meta={meta}
              primary={isLinked && accounts[0]?.providerId === p.id}
              primaryLabel={t("account.connected.providers.primary")}
              action={action}
            />
          );
        })}
        {disconnect.isError && (
          <div className="mt-2 text-xs text-rv-danger">
            {disconnect.error?.message}
          </div>
        )}
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
            action={
              <Button variant="light">
                {t("account.connected.apps.revoke")}
              </Button>
            }
          />
        ))}
      </SectionCard>
    </AccountShell>
  );
}
