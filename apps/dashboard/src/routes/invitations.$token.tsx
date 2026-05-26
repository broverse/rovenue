import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type {
  AcceptInvitationResponse,
  InvitationPreviewResponse,
} from "@rovenue/shared";
import { api } from "../lib/api";
import { signIn, useSession } from "../lib/auth";
import { Button } from "../ui/button";

export const Route = createFileRoute("/invitations/$token")({
  component: InvitationLanding,
});

function InvitationLanding() {
  const { t } = useTranslation();
  const { token } = Route.useParams();
  const session = useSession();
  const sessionUser = session.data?.user;

  const [preview, setPreview] = useState<InvitationPreviewResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<InvitationPreviewResponse>(`/api/invitations/${token}`)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : t("invitationsLanding.errors.notFound"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  useEffect(() => {
    if (!preview || preview.status !== "pending" || !sessionUser) return;
    if (sessionUser.email.toLowerCase() !== preview.email.toLowerCase()) return;
    if (accepting || accepted) return;
    setAccepting(true);
    api<AcceptInvitationResponse>(`/api/invitations/${token}/accept`, {
      method: "POST",
    })
      .then((res) => {
        setAccepted(true);
        window.location.href = `/projects/${res.projectId}`;
      })
      .catch((e: unknown) => {
        setError(
          e instanceof Error
            ? e.message
            : t("invitationsLanding.errors.acceptFailed"),
        );
      })
      .finally(() => setAccepting(false));
  }, [preview, sessionUser, token, t, accepting, accepted]);

  if (error) {
    return (
      <Centered>
        <h1 className="mb-2 text-xl font-semibold">
          {t("common.error", "Error")}
        </h1>
        <p className="text-default-500">{error}</p>
      </Centered>
    );
  }

  if (!preview) {
    return (
      <Centered>
        <p className="text-default-500">{t("common.loading", "Loading…")}</p>
      </Centered>
    );
  }

  // Terminal status (not pending) → static message.
  if (preview.status !== "pending") {
    const k = preview.status;
    return (
      <Centered>
        <h1 className="mb-2 text-xl font-semibold">
          {t(`invitationsLanding.${k}.title`)}
        </h1>
        <p className="text-default-500">{t(`invitationsLanding.${k}.body`)}</p>
      </Centered>
    );
  }

  // Pending but signed in as wrong user.
  if (
    sessionUser &&
    sessionUser.email.toLowerCase() !== preview.email.toLowerCase()
  ) {
    return (
      <Centered>
        <h1 className="mb-2 text-xl font-semibold">
          {t("invitationsLanding.mismatch.title")}
        </h1>
        <p className="text-default-700">
          {t("invitationsLanding.mismatch.body", {
            me: sessionUser.email,
            them: preview.email,
          })}
        </p>
      </Centered>
    );
  }

  // Pending and either auto-accepting or waiting for session to load.
  if (sessionUser) {
    return (
      <Centered>
        <p className="text-default-500">
          {accepting
            ? t("invitationsLanding.joining")
            : t("common.loading", "Loading…")}
        </p>
      </Centered>
    );
  }

  // Pending + unauthenticated → OAuth buttons.
  const callbackURL = `${window.location.origin}/invitations/${token}`;
  return (
    <Centered>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {t("invitationsLanding.invite.title", {
            project: preview.projectName,
          })}
        </h1>
        <p className="text-sm text-default-500">
          {t("invitationsLanding.invite.body", {
            inviter:
              preview.inviterName ??
              t("invitationsLanding.invite.someone"),
            email: preview.email,
            project: preview.projectName,
            role: preview.role,
          })}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button
          variant="flat"
          size="md"
          className="w-full justify-center"
          onClick={() =>
            signIn.social({
              provider: "github",
              callbackURL,
              errorCallbackURL: `${window.location.origin}/login`,
            })
          }
        >
          {t("auth.continueWithGithub", "Sign in with GitHub")}
        </Button>
        <Button
          variant="flat"
          size="md"
          className="w-full justify-center"
          onClick={() =>
            signIn.social({
              provider: "google",
              callbackURL,
              errorCallbackURL: `${window.location.origin}/login`,
            })
          }
        >
          {t("auth.continueWithGoogle", "Sign in with Google")}
        </Button>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md p-6">{children}</Card>
    </div>
  );
}
