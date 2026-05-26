import { Button, Heading, Text } from "@react-email/components";
import type { TFunction } from "i18next";
import { BaseLayout } from "./base-layout";

const buttonStyle = {
  background: "#111",
  color: "white",
  padding: "10px 16px",
  borderRadius: 6,
  marginTop: 16,
} as const;

export interface SimpleAlertProps {
  t: TFunction;
  preview: string;
  headline: string;
  body: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  cta?: { label: string; href: string };
  /** Optional secondary paragraph (e.g. timestamp / context). */
  meta?: string;
}

export function SimpleAlert({
  t,
  preview,
  headline,
  body,
  meta,
  cta,
  managePreferencesUrl,
  unsubscribeUrl,
}: SimpleAlertProps) {
  return (
    <BaseLayout
      t={t}
      preview={preview}
      managePreferencesUrl={managePreferencesUrl}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Heading>{headline}</Heading>
      <Text>{body}</Text>
      {meta ? (
        <Text style={{ fontSize: 12, color: "#6b7280" }}>{meta}</Text>
      ) : null}
      {cta ? (
        <Button href={cta.href} style={buttonStyle}>
          {cta.label}
        </Button>
      ) : null}
    </BaseLayout>
  );
}
