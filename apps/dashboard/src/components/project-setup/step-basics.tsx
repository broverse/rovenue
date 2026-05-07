import { useTranslation } from "react-i18next";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field } from "./field";
import { IconPicker } from "./icon-picker";
import { PrefixInput } from "./prefix-input";
import { TagInput } from "./tag-input";
import { CardPick, CardPickGrid } from "./card-pick";
import { StepHead } from "./step-head";
import { sanitizeSlug } from "./format";
import type { EnvironmentId, SetupForm, SetupMode } from "./types";

type StepBasicsProps = {
  form: SetupForm;
  mode: SetupMode;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
};

const ENV_OPTIONS: ReadonlyArray<EnvironmentId> = [
  "production",
  "staging",
  "sandbox",
];

export function StepBasics({ form, mode, onUpdate }: StepBasicsProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.basics.eyebrow")}
        title={t("projectSetup.basics.title")}
        description={t("projectSetup.basics.description")}
      />

      <div className="mb-6 flex items-start gap-4">
        <IconPicker
          iconText={form.icon}
          name={form.name}
          color={form.iconColor}
          onColorChange={(next) => onUpdate("iconColor", next)}
        />

        <div className="min-w-0 flex-1">
          <Field
            label={t("projectSetup.basics.name")}
            optional={t("projectSetup.basics.required")}
            hint={t("projectSetup.basics.nameHint", {
              count: form.name.length,
              max: 64,
            })}
          >
            <Input
              placeholder={t("projectSetup.basics.namePlaceholder")}
              value={form.name}
              maxLength={64}
              onChange={(event) => onUpdate("name", event.target.value)}
            />
          </Field>

          <Field
            label={t("projectSetup.basics.slug")}
            optional={t(
              isUpdate
                ? "projectSetup.basics.slugLocked"
                : "projectSetup.basics.slugAuto",
            )}
            hint={
              form.slug
                ? `app.rovenue.io/${form.slug}`
                : t("projectSetup.basics.slugHintEmpty")
            }
          >
            <PrefixInput
              prefix="app.rovenue.io /"
              value={form.slug}
              disabled={isUpdate}
              placeholder={t("projectSetup.basics.slugPlaceholder")}
              onChange={(event) =>
                onUpdate("slug", sanitizeSlug(event.target.value))
              }
            />
          </Field>
        </div>
      </div>

      <Field
        label={t("projectSetup.basics.descLabel")}
        optional={t("projectSetup.basics.optional")}
        hint={t("projectSetup.basics.descriptionHint", {
          count: form.desc.length,
          max: 400,
        })}
      >
        <Textarea
          placeholder={t("projectSetup.basics.descriptionPlaceholder")}
          value={form.desc}
          maxLength={400}
          onChange={(event) => onUpdate("desc", event.target.value)}
        />
      </Field>

      <Field
        label={t("projectSetup.basics.environment")}
        optional={t("projectSetup.basics.required")}
      >
        <CardPickGrid columns={3}>
          {ENV_OPTIONS.map((option) => (
            <CardPick
              key={option}
              selected={form.env === option}
              onSelect={() => onUpdate("env", option)}
              title={t(`projectSetup.basics.envOptions.${option}.name`)}
              description={t(`projectSetup.basics.envOptions.${option}.desc`)}
            />
          ))}
        </CardPickGrid>
      </Field>

      <Field
        label={t("projectSetup.basics.tags")}
        optional={t("projectSetup.basics.optional")}
        hint={t("projectSetup.basics.tagsHint")}
      >
        <TagInput
          value={form.tags}
          onChange={(next) => onUpdate("tags", next)}
          placeholder={t("projectSetup.basics.tagsPlaceholder")}
        />
      </Field>
    </>
  );
}
