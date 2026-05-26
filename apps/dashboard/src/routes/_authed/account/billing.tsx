import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  AccountPageHeader,
  AccountShell,
  Field,
  FieldRow,
  SectionCard,
} from "../../../components/account";
import { PaymentMethodRow, PlanCard } from "../../../components/billing";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Select } from "../../../ui/select";

export const Route = createFileRoute("/_authed/account/billing")({
  component: BillingPage,
});

function BillingPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="billing">
      <AccountPageHeader
        title={t("account.billing.title")}
        description={t("account.billing.subtitle")}
      />

      <PlanCard
        eyebrow={t("account.billing.plan.eyebrow")}
        name={t("account.billing.plan.name")}
        description={t("account.billing.plan.description")}
        stats={[
          {
            label: t("account.billing.plan.stats.monthly"),
            value: (
              <>
                $499
                <span className="ml-1 text-[11px] text-rv-mute-500">
                  {t("account.billing.plan.stats.perMonth")}
                </span>
              </>
            ),
          },
          {
            label: t("account.billing.plan.stats.nextBill"),
            value: "Jun 1, 2026",
            mono: true,
          },
          {
            label: t("account.billing.plan.stats.cycle"),
            value: t("account.billing.plan.stats.cycleValue"),
            mono: true,
          },
        ]}
        actions={
          <>
            <Button variant="solid-primary">{t("account.billing.plan.upgrade")}</Button>
            <Button variant="flat">
              {t("account.billing.plan.switchAnnual")}
              <span className="ml-1 text-[10px] text-rv-success">
                {t("account.billing.plan.save")}
              </span>
            </Button>
            <Button variant="light">{t("account.billing.plan.cancel")}</Button>
          </>
        }
      />

      <SectionCard
        title={t("account.billing.payment.title")}
        description={t("account.billing.payment.subtitle")}
      >
        <PaymentMethodRow
          brand="VISA"
          brandStyle={{ background: "linear-gradient(135deg, #1A1F71, #2563EB)" }}
          number="VISA •••• 4242"
          meta="Expires 11/27 · Aiden Kowalski"
          isDefault
        />
        <PaymentMethodRow
          brand="MC"
          brandStyle={{ background: "#FF5F00" }}
          number="Mastercard •••• 8821"
          meta="Expires 02/28 · Lumen Labs Inc."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="light">{t("account.billing.payment.setDefault")}</Button>
              <Button variant="light">{t("account.billing.payment.remove")}</Button>
            </div>
          }
        />
        <Button variant="flat" className="mt-2">
          <Plus size={13} />
          {t("account.billing.payment.add")}
        </Button>
      </SectionCard>

      <SectionCard
        title={t("account.billing.details.title")}
        description={t("account.billing.details.subtitle")}
        meta={t("account.billing.details.savedAuto")}
        footer={
          <>
            <Button variant="flat">{t("common.cancel")}</Button>
            <Button variant="solid-primary">{t("common.save")}</Button>
          </>
        }
      >
        <FieldRow>
          <Field label={t("account.billing.details.legalEntity")}>
            <Input defaultValue="Lumen Labs, Inc." />
          </Field>
          <Field label={t("account.billing.details.taxId")}>
            <Input mono defaultValue="US-87-1234567" />
          </Field>
        </FieldRow>
        <Field
          label={t("account.billing.details.billingEmail")}
          optional={t("account.billing.details.billingEmailHint")}
        >
          <Input mono defaultValue="billing@lumen.co" />
        </Field>
        <FieldRow>
          <Field label={t("account.billing.details.country")}>
            <Select defaultValue="us">
              <option value="us">United States</option>
              <option value="uk">United Kingdom</option>
              <option value="tr">Türkiye</option>
              <option value="de">Germany</option>
            </Select>
          </Field>
          <Field label={t("account.billing.details.zip")}>
            <Input mono defaultValue="94107" />
          </Field>
        </FieldRow>
        <Field label={t("account.billing.details.address")}>
          <Input defaultValue="548 Market St, Suite 32918" />
        </Field>
        <Field
          label={t("account.billing.details.memo")}
          optional={t("account.billing.details.memoHint")}
        >
          <Input placeholder="e.g. PO #2026-44" />
        </Field>
      </SectionCard>
    </AccountShell>
  );
}
