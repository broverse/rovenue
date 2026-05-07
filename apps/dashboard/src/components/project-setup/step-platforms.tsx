import { Upload, Webhook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { CardPick, CardPickGrid } from "./card-pick";
import { CheckboxRow } from "./checkbox-row";
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

      {form.platforms.includes("web") ? (
        <CredentialCard
          iconBg="#635BFF"
          iconLabel="Sw"
          title={t("projectSetup.platforms.web.title")}
        >
          <Field
            className="mb-0"
            label={t("projectSetup.platforms.web.account")}
            optional={t("projectSetup.basics.required")}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                mono
                placeholder="acct_…"
                value={form.stripeAcct}
                className="flex-1"
                onChange={(event) => onUpdate("stripeAcct", event.target.value)}
              />
              <Button type="button" variant="flat" className="h-9 shrink-0">
                <Webhook className="size-3.5" aria-hidden="true" />
                {t("projectSetup.platforms.web.oauthConnect")}
              </Button>
            </div>
          </Field>
        </CredentialCard>
      ) : null}

      <div className="mt-5">
        <CheckboxRow
          checked={form.sandbox}
          onChange={() => onUpdate("sandbox", !form.sandbox)}
          title={t("projectSetup.platforms.mirror.title")}
          description={t("projectSetup.platforms.mirror.description")}
        />
      </div>
    </>
  );
}
