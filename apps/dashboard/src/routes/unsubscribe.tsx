import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

// =============================================================
// /unsubscribe — public RFC 8058 confirmation page
// =============================================================
//
// Reads ?token=… and POSTs it to the API. Success → "you're
// unsubscribed". 401 (expired) → friendly error + sign-in CTA.
// 400 (malformed / forced-event) → generic error + sign-in CTA.
//
// No auth required — the token IS the auth.

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

interface Search {
  token?: string;
}

export const Route = createFileRoute("/unsubscribe")({
  component: UnsubscribeRoute,
  validateSearch: (search: Record<string, unknown>): Search => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
});

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string; status: number };

async function postUnsubscribe(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/unsubscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.status === 204) return;
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  const err = new Error(message) as Error & { status: number };
  err.status = res.status;
  throw err;
}

function UnsubscribeRoute() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const [state, setState] = useState<State>({ kind: "idle" });

  if (!token) {
    return (
      <Frame>
        <h1 className="text-xl font-semibold">
          {t("unsubscribe.missingToken.title", "Missing unsubscribe token")}
        </h1>
        <p className="mt-2 text-[13px] text-rv-mute-500">
          {t(
            "unsubscribe.missingToken.body",
            "The link you followed doesn't contain a valid token. Open the latest notification email and click the unsubscribe link again.",
          )}
        </p>
      </Frame>
    );
  }

  if (state.kind === "ok") {
    return (
      <Frame>
        <h1 className="text-xl font-semibold">
          {t("unsubscribe.success.title", "You're unsubscribed")}
        </h1>
        <p className="mt-2 text-[13px] text-rv-mute-500">
          {t(
            "unsubscribe.success.body",
            "We won't send you this kind of email again. You can re-enable it any time from your account settings.",
          )}
        </p>
        <div className="mt-6">
          <Link to="/account/notifications" className="underline">
            {t("unsubscribe.success.cta", "Manage notification preferences")}
          </Link>
        </div>
      </Frame>
    );
  }

  if (state.kind === "error") {
    const expired = state.status === 401;
    return (
      <Frame>
        <h1 className="text-xl font-semibold">
          {expired
            ? t("unsubscribe.expired.title", "This link has expired")
            : t("unsubscribe.error.title", "We couldn't unsubscribe you")}
        </h1>
        <p className="mt-2 text-[13px] text-rv-mute-500">
          {expired
            ? t(
                "unsubscribe.expired.body",
                "Unsubscribe links expire after 30 days. Sign in to update your preferences manually.",
              )
            : state.message}
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            to="/login"
            className="rounded-md bg-rv-accent-500 px-3 py-1.5 text-[12px] font-medium text-white"
          >
            {t("unsubscribe.error.signIn", "Sign in")}
          </Link>
          <Link
            to="/account/notifications"
            className="rounded-md border border-rv-divider px-3 py-1.5 text-[12px]"
          >
            {t("unsubscribe.error.prefs", "Notification settings")}
          </Link>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="text-xl font-semibold">
        {t("unsubscribe.confirm.title", "Confirm unsubscribe")}
      </h1>
      <p className="mt-2 text-[13px] text-rv-mute-500">
        {t(
          "unsubscribe.confirm.body",
          "We'll stop sending you the email type this link covers. Required security notifications still send.",
        )}
      </p>
      <div className="mt-6">
        <Button
          variant="solid-primary"
          disabled={state.kind === "pending"}
          onClick={async () => {
            setState({ kind: "pending" });
            try {
              await postUnsubscribe(token);
              setState({ kind: "ok" });
            } catch (err) {
              const status =
                err instanceof Error && "status" in err
                  ? (err as { status: number }).status
                  : 500;
              setState({
                kind: "error",
                message: err instanceof Error ? err.message : String(err),
                status,
              });
            }
          }}
        >
          {state.kind === "pending"
            ? t("unsubscribe.confirm.pending", "Unsubscribing…")
            : t("unsubscribe.confirm.cta", "Unsubscribe me")}
        </Button>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-rv-bg p-6 text-foreground">
      <div className="mx-auto mt-16 max-w-md rounded-md border border-rv-divider bg-rv-c1 p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
