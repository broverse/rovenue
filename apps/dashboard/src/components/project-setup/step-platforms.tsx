import { Upload, Webhook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import { API_BASE_URL } from "../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { CardPick, CardPickGrid } from "./card-pick";
import { CredentialCard } from "./credential-card";
import { Field } from "./field";
import { PlatformIcon } from "./platform-icon";
import { StepHead } from "./step-head";
import { PLATFORMS } from "./mock-data";
import type { PlatformId, SetupForm } from "./types";

type StepPlatformsProps = {
  form: SetupForm;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
  onTogglePlatform: (id: PlatformId) => void;
};

export function StepPlatforms({
  form,
  onUpdate,
  onTogglePlatform,
}: StepPlatformsProps) {
  const { t } = useTranslation();
  // The wizard renders in two modes. In update mode it sits inside the
  // /projects/$projectId/edit route, so the ambient param gives us a real
  // project to connect. In create mode there is no $projectId segment and
  // this is undefined — which is correct, the project does not exist yet.
  // `strict: false` is the codebase's idiom for shared components that
  // read a route param without being route components themselves.
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.platforms.eyebrow")}
        title={t("projectSetup.platforms.title")}
        description={t("projectSetup.platforms.description")}
      />

      <CardPickGrid>
        {PLATFORMS.map((platform) => (
          <CardPick
            key={platform.id}
            selected={form.platforms.includes(platform.id)}
            onSelect={() => onTogglePlatform(platform.id)}
            title={t(`projectSetup.platforms.options.${platform.id}.name`)}
            description={t(
              `projectSetup.platforms.options.${platform.id}.desc`,
            )}
            leading={<PlatformIcon bg={platform.bg} label={platform.txt} />}
          />
        ))}
      </CardPickGrid>

      {form.platforms.includes("ios") ? (
        <CredentialCard
          iconBg="#0A84FF"
          iconLabel="iOS"
          title={t("projectSetup.platforms.ios.title")}
        >
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field
              className="mb-0"
              label={t("projectSetup.platforms.ios.bundleId")}
              optional={t("projectSetup.basics.required")}
            >
              <Input
                mono
                placeholder="com.example.app"
                value={form.bundleId}
                onChange={(event) => onUpdate("bundleId", event.target.value)}
              />
            </Field>
            <Field
              className="mb-0"
              label={t("projectSetup.platforms.ios.issuerId")}
            >
              <Input
                mono
                placeholder="69a6de5a-…-3acb"
                value={form.storeIssuer}
                onChange={(event) => onUpdate("storeIssuer", event.target.value)}
              />
            </Field>
            <Field
              className="mb-0"
              label={t("projectSetup.platforms.ios.keyId")}
            >
              <Input
                mono
                placeholder="ABC123XYZ"
                value={form.storeKeyId}
                onChange={(event) => onUpdate("storeKeyId", event.target.value)}
              />
            </Field>
            <Field
              className="mb-0"
              label={t("projectSetup.platforms.ios.privateKey")}
            >
              <Button type="button" variant="flat" className="h-9 w-full justify-start">
                <Upload className="size-3.5" aria-hidden="true" />
                {t("projectSetup.platforms.ios.uploadP8")}
              </Button>
            </Field>
          </div>
        </CredentialCard>
      ) : null}

      {form.platforms.includes("android") ? (
        <CredentialCard
          iconBg="#3DDC84"
          iconLabel="PS"
          title={t("projectSetup.platforms.android.title")}
        >
          <Field
            label={t("projectSetup.platforms.android.packageName")}
            optional={t("projectSetup.basics.required")}
          >
            <Input
              mono
              placeholder="com.example.app"
              value={form.androidPackage}
              onChange={(event) =>
                onUpdate("androidPackage", event.target.value)
              }
            />
          </Field>
          <Field
            className="mb-0"
            label={t("projectSetup.platforms.android.serviceAccount")}
          >
            <Button type="button" variant="flat" className="h-9 w-full justify-start">
              <Upload className="size-3.5" aria-hidden="true" />
              {t("projectSetup.platforms.android.uploadJson")}
            </Button>
          </Field>
        </CredentialCard>
      ) : null}

      {form.platforms.includes("stripe") ? (
        <CredentialCard
          iconBg="#635BFF"
          iconLabel="St"
          title={t("projectSetup.platforms.stripe.title")}
        >
          {projectId ? (
            <Button
              type="button"
              variant="flat"
              className="h-9 w-full justify-start"
              onClick={() => {
                // The connect endpoint answers with a 302 to Stripe's
                // consent screen, so this must be a full-page navigation
                // rather than a fetch — same as StripeConnectCard.
                window.location.href = `${API_BASE_URL}/dashboard/projects/${projectId}/stripe/connect`;
              }}
            >
              <Webhook className="size-3.5" aria-hidden="true" />
              {t("projectSetup.platforms.stripe.oauthConnect")}
            </Button>
          ) : (
            // Create mode: the project genuinely does not exist yet, so
            // there is no id to connect against. Point at where the real
            // flow lives instead of faking one.
            <p className="text-[12.5px] text-rv-mute-500">
              {t("projectSetup.platforms.stripe.connectHint")}
            </p>
          )}
        </CredentialCard>
      ) : null}
    </>
  );
}
