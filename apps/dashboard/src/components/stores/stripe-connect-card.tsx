import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard, ExternalLink } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { API_BASE_URL } from "../../lib/api";
import {
  useDisconnectStripe,
  useStripeConnection,
} from "../../lib/hooks/useStripeConnection";

interface Props {
  projectId: string;
}

/**
 * Stripe Connect status card. Replaces the raw secret-key/webhook-secret
 * form with an OAuth connect/disconnect flow (Task 10 removes the old
 * `StoreCredentialCard` stripe branch once this has landed everywhere).
 */
export function StripeConnectCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch, isFetching } =
    useStripeConnection(projectId);
  const disconnect = useDisconnectStripe(projectId);
  const [testMode, setTestMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A failed status lookup must not look like a card that is still
  // loading: without its own branch the `!data` guard below swallows the
  // error and spins forever, leaving the owner no way to retry.
  if (isError) {
    return (
      <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5 sm:px-5">
        <span className="text-[13px] font-semibold text-foreground">
          {t("stores.stripe.connect.title")}
        </span>
        <p
          data-testid="stripe-connection-error"
          className="mt-2 text-[11.5px] text-rv-danger"
        >
          {t("stores.stripe.connect.loadFailed")}
        </p>
        <Button
          variant="light"
          size="sm"
          className="mt-2"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {t("stores.stripe.connect.retry")}
        </Button>
      </section>
    );
  }

  if (isLoading || !data) {
    return (
      <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5 sm:px-5">
        <span className="text-[13px] font-semibold text-foreground">
          {t("stores.stripe.connect.title")}
        </span>
      </section>
    );
  }

  const { platformConfigured, testModeAvailable, connection } = data;
  const showConnectButton = platformConfigured && !connection;
  const showDisconnectButton = Boolean(connection);

  const handleConnect = () => {
    // The connect endpoint answers with a 302 to Stripe's consent screen,
    // so this must be a full-page navigation, not a fetch.
    const url = new URL(
      `${API_BASE_URL}/dashboard/projects/${projectId}/stripe/connect`,
    );
    if (testMode) url.searchParams.set("mode", "test");
    window.location.href = url.toString();
  };

  const handleDisconnect = async () => {
    await disconnect.mutateAsync();
  };

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600">
            <CreditCard size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-foreground">
                {t("stores.stripe.connect.title")}
              </span>
              {connection ? (
                <Chip
                  tone={connection.livemode ? "success" : "default"}
                  data-testid="stripe-livemode-badge"
                >
                  {connection.livemode
                    ? t("stores.stripe.connect.liveBadge")
                    : t("stores.stripe.connect.testBadge")}
                </Chip>
              ) : null}
            </div>
            <p className="mt-0.5 max-w-md text-[12px] text-rv-mute-500">
              {t("stores.stripe.connect.description")}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {showDisconnectButton ? (
            <Button
              variant="flat"
              size="sm"
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending
                ? t("stores.stripe.connect.disconnecting")
                : t("stores.stripe.connect.disconnect")}
            </Button>
          ) : null}
          {showConnectButton ? (
            <Button
              variant="solid-primary"
              size="sm"
              type="button"
              data-testid="stripe-connect-button"
              onClick={handleConnect}
            >
              {t("stores.stripe.connect.connectButton")}
              <ExternalLink size={13} />
            </Button>
          ) : null}
        </div>
      </header>

      {!platformConfigured && !connection ? (
        <p
          data-testid="stripe-platform-unconfigured"
          className="border-t border-rv-divider px-4 py-2.5 text-[11.5px] text-rv-mute-500 sm:px-5"
        >
          {t("stores.stripe.connect.platformUnconfigured")}
        </p>
      ) : connection ? (
        <div className="border-t border-rv-divider px-4 py-3.5 sm:px-5">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-rv-mute-500">
              {t("stores.stripe.connect.accountLabel")}
            </span>
            <span className="font-rv-mono">{connection.accountId}</span>
          </div>
          {!connection.chargesEnabled ? (
            <p
              data-testid="stripe-verification-pending"
              className="mt-2 text-[11.5px] text-rv-warning"
            >
              {t("stores.stripe.connect.verificationPending")}
            </p>
          ) : null}
        </div>
      ) : testModeAvailable ? (
        <div
          data-testid="stripe-connect-test-mode"
          className="border-t border-rv-divider px-4 py-3 sm:px-5"
        >
          <label className="flex items-center gap-2 text-[12px] text-rv-mute-600">
            <input
              type="checkbox"
              checked={testMode}
              onChange={(e) => setTestMode(e.target.checked)}
            />
            {t("stores.stripe.connect.testModeToggle")}
          </label>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t("stores.stripe.connect.disconnectTitle")}
        description={t("stores.stripe.connect.disconnectBody")}
        confirmLabel={t("stores.stripe.connect.disconnect")}
        tone="danger"
        onConfirm={handleDisconnect}
        onClose={() => setConfirmOpen(false)}
      />
    </section>
  );
}
