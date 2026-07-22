import { useEffect, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Info, Store, XCircle } from "lucide-react";
import type { CredentialStore } from "@rovenue/shared";
import { StoreCredentialCard } from "../../../../components/stores";
import { StripeConnectCard } from "../../../../components/stores/stripe-connect-card";
import { LoadingState } from "../../../../components/dashboard/loading-state";
import { EmptyStateCard } from "../../../../components/dashboard/empty-state-card";
import { useProjectCredentials } from "../../../../lib/hooks/useProjectCredentials";
import { useProjects } from "../../../../lib/hooks/useProjects";
import { cn } from "../../../../lib/cn";

const STORES: CredentialStore[] = ["apple", "google"];

/** The four outcomes the OAuth callback redirects the stores page with. */
const STRIPE_OUTCOMES = [
  "connected",
  "declined",
  "error",
  "already_connected",
  // The Stripe account the customer authorised is already linked to a
  // different Rovenue project. We revoked the authorisation rather than
  // create a second link, because webhooks for one account can only be
  // routed to one project.
  "account_in_use",
] as const;
type StripeOutcome = (typeof STRIPE_OUTCOMES)[number];

type StoresSearch = {
  stripe?: StripeOutcome;
};

export const Route = createFileRoute("/_authed/projects/$projectId/stores")({
  component: StoresRoute,
  validateSearch: (raw: Record<string, unknown>): StoresSearch => ({
    stripe:
      typeof raw.stripe === "string" &&
      (STRIPE_OUTCOMES as readonly string[]).includes(raw.stripe)
        ? (raw.stripe as StripeOutcome)
        : undefined,
  }),
});

function StoresRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/stores" });
  return <StoresPage projectId={projectId} />;
}

function StoresPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const credentials = useProjectCredentials(projectId);
  // Writes are OWNER-only on the server; reflect that in the UI so non-owners
  // see status read-only instead of hitting a 403 on save.
  const projects = useProjects();
  const role = projects.data?.find((p) => p.id === projectId)?.role;
  const canEdit = role === "OWNER";

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [stripeOutcome, setStripeOutcome] = useState<StripeOutcome | null>(null);

  // The Stripe OAuth callback redirects here with `?stripe=<outcome>`. Move
  // it into local state immediately and strip the query param so a refresh
  // or back-navigation doesn't re-show the banner.
  useEffect(() => {
    if (!search.stripe) return;
    setStripeOutcome(search.stripe);
    void navigate({ search: (prev) => ({ ...prev, stripe: undefined }), replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.stripe]);

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
          {t("stores.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[12.5px] text-rv-mute-500 sm:text-[13px]">
          {t("stores.subtitle")}
        </p>
      </header>

      {stripeOutcome ? (
        <StripeCallbackBanner outcome={stripeOutcome} onDismiss={() => setStripeOutcome(null)} />
      ) : null}

      {credentials.isLoading ? (
        <LoadingState />
      ) : credentials.isError || !credentials.data ? (
        <EmptyStateCard
          icon={Store}
          title={t("stores.loadError")}
          description={t("stores.loadErrorHint")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <StripeConnectCard projectId={projectId} />
          {STORES.map((store) => (
            <StoreCredentialCard
              key={store}
              projectId={projectId}
              store={store}
              status={credentials.data.credentials[store]}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
    </>
  );
}

const OUTCOME_KEY: Record<StripeOutcome, string> = {
  connected: "connected",
  declined: "declined",
  error: "error",
  already_connected: "alreadyConnected",
  account_in_use: "accountInUse",
};

function StripeCallbackBanner({
  outcome,
  onDismiss,
}: {
  outcome: StripeOutcome;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // `declined` is the customer backing out of Stripe's consent screen, not
  // an error — and `already_connected` just means another attempt won a
  // race, so both read as informational rather than a failure.
  // `account_in_use` IS a failure: nothing got connected and the customer
  // has to pick a different Stripe account.
  const tone: "success" | "danger" | "info" = outcome === "connected"
    ? "success"
    : outcome === "error" || outcome === "account_in_use"
      ? "danger"
      : "info";
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? XCircle : Info;

  return (
    <div
      data-testid="stripe-callback-banner"
      data-outcome={outcome}
      className={cn(
        "mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[12.5px]",
        tone === "success" && "border-rv-success/30 bg-rv-success/10 text-rv-success",
        tone === "danger" && "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
        tone === "info" && "border-rv-divider bg-rv-c2 text-rv-mute-700",
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <p className="flex-1">{t(`stores.stripe.connect.callback.${OUTCOME_KEY[outcome]}`)}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[11.5px] font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
      >
        {t("common.dismiss", "Dismiss")}
      </button>
    </div>
  );
}
