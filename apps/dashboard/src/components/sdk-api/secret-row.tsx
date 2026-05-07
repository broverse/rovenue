import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, RotateCw } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip, type ChipProps } from "../../ui/chip";
import { CopyButton } from "../../ui/copy-button";
import type { ProjectSecret } from "./types";

type Props = {
  secret: ProjectSecret;
  /** Publishable keys are read-only and visible by default. */
  readOnly?: boolean;
};

const KIND_TONE: Record<ProjectSecret["kind"], NonNullable<ChipProps["tone"]>> = {
  publishable: "primary",
  secret: "warning",
  webhook: "default",
};

export function SecretRow({ secret, readOnly = false }: Props) {
  const { t } = useTranslation();
  const isHideable = !readOnly;
  const [revealed, setRevealed] = useState(!isHideable);

  return (
    <div className="grid items-center gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3.5 py-3 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium leading-5">
            {t(`sdkApi.keys.items.${secret.labelKey}`)}
          </span>
          <Chip tone={KIND_TONE[secret.kind]}>
            {t(`sdkApi.keys.kinds.${secret.kind}`)}
          </Chip>
          <Chip>{t(`sdkApi.keys.environments.${secret.environmentKey}`)}</Chip>
        </div>
        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          {t(`sdkApi.keys.created.${secret.createdKey}`)}
        </div>
      </div>

      <div className="hidden min-w-0 sm:block">
        <code className="block truncate rounded border border-rv-divider bg-rv-c3 px-2 py-1.5 font-rv-mono text-[11.5px] text-rv-mute-700">
          {revealed ? secret.value : secret.preview}
        </code>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isHideable ? (
          <Button
            variant="flat"
            size="sm"
            onClick={() => setRevealed((prev) => !prev)}
            aria-pressed={revealed}
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealed ? t("sdkApi.keys.actions.hide") : t("sdkApi.keys.actions.reveal")}
          </Button>
        ) : null}
        <CopyButton
          size="sm"
          value={secret.value}
          label={t("sdkApi.copy.idle")}
          copiedLabel={t("sdkApi.copy.copied")}
        />
        {!readOnly ? (
          <Button variant="light" size="sm">
            <RotateCw size={13} />
            {t("sdkApi.keys.actions.rotate")}
          </Button>
        ) : null}
      </div>

      <div className="col-span-2 sm:hidden">
        <code className="block truncate rounded border border-rv-divider bg-rv-c3 px-2 py-1.5 font-rv-mono text-[11.5px] text-rv-mute-700">
          {revealed ? secret.value : secret.preview}
        </code>
      </div>
    </div>
  );
}
