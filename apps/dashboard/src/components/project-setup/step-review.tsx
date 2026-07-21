import { useTranslation } from "react-i18next";
import { ReviewRow, ReviewSection } from "./review-section";
import { StepHead } from "./step-head";
import type { SetupForm, SetupMode } from "./types";

type StepReviewProps = {
  form: SetupForm;
  mode: SetupMode;
  onJump: (id: number) => void;
};

export function StepReview({ form, mode, onJump }: StepReviewProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.review.eyebrow")}
        title={t(
          isUpdate ? "projectSetup.review.titleUpdate" : "projectSetup.review.titleCreate",
        )}
        description={t(
          isUpdate
            ? "projectSetup.review.descriptionUpdate"
            : "projectSetup.review.descriptionCreate",
        )}
      />

      <ReviewSection
        index={1}
        title={t("projectSetup.steps.basics.label")}
        onEdit={() => onJump(1)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.name")}
          value={form.name || t("projectSetup.review.notSet")}
          empty={!form.name}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.description")}
          value={form.desc || t("projectSetup.review.notSet")}
          empty={!form.desc}
        />
      </ReviewSection>

      <ReviewSection
        index={2}
        title={t("projectSetup.steps.platforms.label")}
        onEdit={() => onJump(2)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.activePlatforms")}
          value={
            form.platforms.length
              ? form.platforms.join(", ")
              : t("projectSetup.review.platformsEmpty")
          }
          empty={form.platforms.length === 0}
        />
        {form.platforms.includes("ios") ? (
          <ReviewRow
            label={t("projectSetup.review.fields.iosBundle")}
            value={form.bundleId || t("projectSetup.review.notSet")}
            empty={!form.bundleId}
          />
        ) : null}
        {form.platforms.includes("android") ? (
          <ReviewRow
            label={t("projectSetup.review.fields.androidPackage")}
            value={form.androidPackage || t("projectSetup.review.notSet")}
            empty={!form.androidPackage}
          />
        ) : null}
      </ReviewSection>

      <ReviewSection
        index={3}
        title={t("projectSetup.steps.currency.label")}
        onEdit={() => onJump(3)}
      >
        <ReviewRow
          label={t("projectSetup.review.fields.reportingCurrency")}
          value={`${form.currency} · ${t("projectSetup.review.fxFrom", {
            source: form.fxSource.toUpperCase(),
          })}`}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.timezone")}
          value={form.timezone}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.weekStart")}
          value={t(`projectSetup.currency.weekOptions.${form.weekStart}`)}
        />
        <ReviewRow
          label={t("projectSetup.review.fields.fiscalYear")}
          value={t(`projectSetup.currency.months.${form.fiscalMonth}`)}
        />
      </ReviewSection>
    </>
  );
}
