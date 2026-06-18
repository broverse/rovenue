import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { useProjectOfferings } from "../../lib/hooks/useProjectOfferings";
import { OfferingFormDialog } from "../offerings";

interface Props {
  projectId: string;
  accessId: string | null;
}

/**
 * Sidebar/inset section that lists all project offerings. The access-to-offering
 * relationship was removed in the decoupled model — access rights now live on
 * individual products via `accessIds`. This component lists all offerings and
 * lets the user create a new one; the dedicated /offerings route provides richer
 * package management.
 *
 * Note: selecting an offering here just highlights the row; deep dives
 * happen via navigation on the dedicated offerings route.
 */
export function AccessOfferingsSection({ projectId, accessId }: Props) {
  const { t } = useTranslation();
  const offeringsQuery = useProjectOfferings(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState<string | null>(
    null,
  );

  if (!accessId) {
    return (
      <div className="text-xs text-rv-mute-500 py-4">
        {t(
          "access.offerings.placeholder",
          "Select an access to see its offerings.",
        )}
      </div>
    );
  }

  const rows = offeringsQuery.data?.offerings ?? [];

  return (
    <section className="border-t border-rv-divider mt-6 pt-4">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          {t("access.offerings.heading", "Offerings")}
        </h3>
        <Button size="sm" variant="flat" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5 mr-1" />
          {t("access.offerings.create", "New offering")}
        </Button>
      </header>

      {rows.length === 0 && (
        <p className="text-xs text-rv-mute-500">
          {t(
            "access.offerings.empty",
            "No offerings yet — create one to use this access on a paywall.",
          )}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {rows.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              className={
                "text-left text-xs px-2 py-1 hover:bg-rv-c4 rounded-sm w-full" +
                (selectedOfferingId === o.id ? " bg-rv-c4" : "")
              }
              onClick={() => setSelectedOfferingId(o.id)}
            >
              <span className="font-rv-mono">{o.identifier}</span>
              {o.isDefault && (
                <span className="text-rv-violet ml-2">
                  {t("access.offerings.defaultBadge", "Default")}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <OfferingFormDialog
        open={createOpen}
        mode="create"
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
      />
    </section>
  );
}
