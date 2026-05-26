import { useMemo, type ReactNode } from "react";
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

type ProviderId = "google" | "github";

interface ProviderDef {
  id: ProviderId;
  icon: ReactNode;
  glyphClassName: string;
}

const GoogleGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.63z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);

const GithubGlyph = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    className="text-white"
  >
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2.05c-3.2.7-3.87-1.36-3.87-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.89-.39c.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.13v3.16c0 .3.21.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
  </svg>
);

const PROVIDERS: ReadonlyArray<ProviderDef> = [
  {
    id: "google",
    icon: <GoogleGlyph />,
    glyphClassName: "bg-white",
  },
  {
    id: "github",
    icon: <GithubGlyph />,
    glyphClassName: "bg-[#24292F]",
  },
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

  // The primary identity is whichever provider was linked first —
  // unlinking it would orphan the account, so we disable that action.
  const primaryProviderId = useMemo(() => {
    if (accounts.length === 0) return null;
    return accounts.reduce((earliest, a) =>
      new Date(a.createdAt).getTime() < new Date(earliest.createdAt).getTime()
        ? a
        : earliest,
    ).providerId;
  }, [accounts]);

  const handleConnect = async (provider: ProviderId) => {
    await authClient.signIn.social({
      provider,
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
          const isPrimary = isLinked && primaryProviderId === p.id;
          const meta = isLinked
            ? t(
                "account.connected.providers.linkedAt",
                "Linked {{date}}",
                { date: new Date(linked!.createdAt).toLocaleDateString() },
              )
            : t("account.connected.providers.notConnected", "Not connected");

          const action = isLinked ? (
            <Button
              variant="flat"
              onClick={() => disconnect.mutate(p.id)}
              disabled={disconnect.isPending || isPrimary}
              title={
                isPrimary
                  ? t(
                      "account.connected.providers.primaryLocked",
                      "Primary sign-in method can't be disconnected",
                    )
                  : undefined
              }
            >
              {t("account.connected.providers.actions.disconnect")}
            </Button>
          ) : (
            <Button variant="flat" onClick={() => handleConnect(p.id)}>
              {t("account.connected.providers.actions.connect")}
            </Button>
          );

          return (
            <ConnectionRow
              key={p.id}
              glyph={p.icon}
              glyphClassName={p.glyphClassName}
              name={t(`account.connected.providers.items.${p.id}.name`)}
              meta={meta}
              primary={isPrimary}
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
    </AccountShell>
  );
}
