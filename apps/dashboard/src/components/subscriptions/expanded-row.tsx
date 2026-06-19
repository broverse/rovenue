import { useState } from "react";
import { Key, MoreHorizontal, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import { Button } from "../../ui/button";
import { useScheduledActions, useDeleteScheduledAction } from "../../lib/hooks/useProjectSubscriptions";
import { RefundConfirmDialog } from "../refund/refund-confirm-dialog";
import { storeFullName } from "./store-chip";
import type { Subscription } from "./types";

type Props = { sub: Subscription };

/**
 * Three-column expanded detail rendered under the active row. Mirrors
 * the design's `.sub-expand-inner` — Lifecycle / Billing / Grants.
 */
export function ExpandedRow({ sub }: Props) {
  const { t } = useTranslation();
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [refundOpen, setRefundOpen] = useState(false);
  const scheduled = useScheduledActions(projectId);
  const del = useDeleteScheduledAction(projectId);
  const mine = (scheduled.data?.rows ?? []).filter(
    (r) => r.purchaseId === sub.id && r.status === "PENDING",
  );

  const lifecycleNext =
    sub.status === "canceling"
      ? t("subscriptions.expanded.lifecycle.willNotRenew")
      : sub.status === "churned"
        ? t("subscriptions.expanded.lifecycle.ended")
        : t("subscriptions.expanded.lifecycle.nextRenewal");

  const lifecycleNextWhen =
    sub.renewsIn > 0
      ? t("subscriptions.expanded.lifecycle.inDays", { days: sub.renewsIn })
      : sub.renewsIn === 0
        ? t("subscriptions.expanded.lifecycle.today")
        : t("subscriptions.expanded.lifecycle.daysAgo", {
            days: -sub.renewsIn,
          });

  return (
    <div className="grid gap-6 px-6 py-4 lg:grid-cols-[1.4fr_1fr_1fr]">
      <Column heading={t("subscriptions.expanded.lifecycle.heading")}>
        <Row dotClass="bg-rv-accent-500">
          <span>
            {sub.trialDays > 0
              ? t("subscriptions.expanded.lifecycle.trialStarted")
              : t("subscriptions.expanded.lifecycle.initialPurchase")}
            <span className="text-rv-mute-500"> · {sub.product}</span>
          </span>
          <When>{sub.started}</When>
        </Row>
        {sub.trialDays > 0 && (
          <Row dotClass="bg-rv-warning">
            <span>
              {t("subscriptions.expanded.lifecycle.trialConverted", {
                price: sub.price.toFixed(2),
              })}
            </span>
            <When>+{sub.trialDays}d</When>
          </Row>
        )}
        <Row dotClass="bg-rv-success">
          <span>
            {t("subscriptions.expanded.lifecycle.renewed", {
              price: sub.price.toFixed(2),
            })}
          </span>
          <When>{t("subscriptions.expanded.lifecycle.cycles", { count: 2 })}</When>
        </Row>
        {sub.lastIssue && (
          <Row dotClass="bg-rv-danger">
            <span>
              {t("subscriptions.expanded.lifecycle.billingIssue")}
              <span className="text-rv-mute-500"> · {sub.lastIssue}</span>
            </span>
            <When>{t("subscriptions.expanded.lifecycle.recent")}</When>
          </Row>
        )}
        <Row dotClass="bg-rv-c4" muted>
          <span>{lifecycleNext}</span>
          <When>{lifecycleNextWhen}</When>
        </Row>
      </Column>

      <Column heading={t("subscriptions.expanded.billing.heading")}>
        <KV
          k={t("subscriptions.expanded.billing.price")}
          v={`$${sub.price.toFixed(2)} / ${sub.billingCycle}`}
        />
        <KV
          k={t("subscriptions.expanded.billing.autoRenew")}
          v={
            sub.autoRenew
              ? t("subscriptions.expanded.billing.on")
              : t("subscriptions.expanded.billing.off")
          }
        />
        <KV
          k={t("subscriptions.expanded.billing.store")}
          v={t(`subscriptions.stores.${sub.store}.full`)}
        />
        <KV
          k={t("subscriptions.expanded.billing.intro")}
          v={
            sub.intro
              ? t("subscriptions.expanded.billing.applied")
              : "—"
          }
        />
        <KV
          k={t("subscriptions.expanded.billing.cancelPolicy")}
          v={sub.cancelPolicy}
        />
        {sub.cancelReason && (
          <KV
            k={t("subscriptions.expanded.billing.cancelReason")}
            v={sub.cancelReason}
          />
        )}
      </Column>

      <Column heading={t("subscriptions.expanded.grants.heading")}>
        {sub.entitlements.length === 0 ? (
          <p className="text-[11px] text-rv-mute-500">
            {t("subscriptions.expanded.grants.empty")}
          </p>
        ) : (
          <ul className="flex flex-col">
            {sub.entitlements.map((ent) => (
              <li
                key={ent}
                className="flex items-center justify-between border-b border-white/[0.04] py-0.5 last:border-b-0"
              >
                <span className="inline-flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-violet">
                  <Key size={10} /> {ent}
                </span>
                <span className="font-rv-mono text-[10px] text-rv-mute-500">
                  {t("subscriptions.expanded.grants.active")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {mine.length > 0 ? (
          <div className="mt-3 rounded-md border border-rv-divider p-2">
            <div className="mb-1 font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t("subscriptions.expanded.scheduled.heading", { defaultValue: "Scheduled" })}
            </div>
            <ul className="flex flex-col gap-1">
              {mine.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="font-rv-mono text-[11px] text-rv-mute-700">
                    {t("subscriptions.expanded.scheduled.cancelAt", {
                      defaultValue: "Cancel on {{date}}",
                      date: new Date(r.dueAt).toLocaleString(),
                    })}
                    {r.payload.revokeImmediately
                      ? ` (${t("subscriptions.expanded.scheduled.revokeImmediately", { defaultValue: "revoke immediately" })})`
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => del.mutate(r.id)}
                    disabled={del.isPending}
                    className="shrink-0 font-rv-mono text-[10px] text-rv-danger opacity-80 hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
                  >
                    {t("subscriptions.expanded.scheduled.remove", { defaultValue: "Remove" })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-3.5 flex items-center gap-1.5">
          {/* Apple processes App Store refunds itself — there is no
              merchant-initiated refund, so hide the action for iOS rows. */}
          {sub.store !== "ios" && (
            <Button
              variant="flat"
              size="sm"
              className="flex-1 text-[11px]"
              onClick={() => setRefundOpen(true)}
            >
              <RotateCcw size={11} />
              {t("subscriptions.expanded.grants.refund")}
            </Button>
          )}
          <Button
            variant="light"
            size="icon"
            aria-label={t("subscriptions.expanded.grants.more")}
          >
            <MoreHorizontal size={13} />
          </Button>
        </div>
        {sub.store !== "ios" && (
          <RefundConfirmDialog
            projectId={projectId}
            kind="subscription"
            id={sub.id}
            storeLabel={storeFullName(sub.store, t)}
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
          />
        )}
      </Column>
    </div>
  );
}

function Column({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {heading}
      </h4>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Row({
  dotClass,
  muted,
  children,
}: {
  dotClass: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-[14px_1fr_auto] items-center gap-2 py-1 font-rv-mono text-[11px] ${
        muted ? "text-rv-mute-500" : "text-rv-mute-700"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 justify-self-center rounded-full ${dotClass}`}
      />
      {children}
    </div>
  );
}

function When({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-rv-mono text-[10px] text-rv-mute-500">
      {children}
    </span>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0">
      <span className="text-rv-mute-500">{k}</span>
      <span className="font-rv-mono text-[11px] text-foreground">{v}</span>
    </div>
  );
}
