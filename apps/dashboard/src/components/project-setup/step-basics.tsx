import { useTranslation } from "react-i18next";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field } from "./field";
import { IconPicker } from "./icon-picker";
import { StepHead } from "./step-head";
import type { SetupForm } from "./types";

type StepBasicsProps = {
  form: SetupForm;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
};

export function StepBasics({ form, onUpdate }: StepBasicsProps) {
  const { t } = useTranslation();

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.basics.eyebrow")}
        title={t("projectSetup.basics.title")}
        description={t("projectSetup.basics.description")}
      />

      <div className="mb-6 flex flex-col items-start gap-4 sm:flex-row">
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
    </>
  );
}
