import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import type { ExperimentStatus } from "./types";

const TONE: Record<ExperimentStatus, "primary" | "success" | "danger" | "default"> = {
  running: "primary",
  completed: "success",
  stopped: "danger",
  draft: "default",
};

type Props = { status: ExperimentStatus };

/**
 * Status pill — wraps the shared `Chip` and resolves the label via i18n.
 * Same visual language as the running dot, just in pill form.
 */
export function ExperimentStatusChip({ status }: Props) {
  const { t } = useTranslation();
  return <Chip tone={TONE[status]}>{t(`experiments.status.${status}`)}</Chip>;
}
