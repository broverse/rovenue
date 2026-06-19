import { useTranslation } from "react-i18next";
import { BookOpen, Webhook } from "lucide-react";
import { Button, buttonVariants } from "../../ui/button";
import { DOCS_URL } from "./mock-data";

type Props = {
  onNewWebhook: () => void;
};

export function BuildYourOwnCard({ onNewWebhook }: Props) {
  const { t } = useTranslation();
  return (
    <section className="mt-6 grid grid-cols-1 items-center gap-4 rounded-lg border border-dashed border-rv-divider bg-rv-c1 p-4 sm:gap-5 sm:p-6 lg:grid-cols-[1fr_auto]">
      <div>
        <h3 className="text-[14px] font-semibold text-foreground">
          {t("apps.buildYourOwn.title")}
        </h3>
        <p className="mt-1.5 text-[12px] leading-[1.55] text-rv-mute-600">
          {t("apps.buildYourOwn.description")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="flat" size="sm" onClick={onNewWebhook}>
          <Webhook size={13} />
          {t("apps.buildYourOwn.newWebhook")}
        </Button>
        <a
          href={`${DOCS_URL}/api`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "flat", size: "sm" })}
        >
          <BookOpen size={13} />
          {t("apps.buildYourOwn.apiReference")}
        </a>
      </div>
    </section>
  );
}
