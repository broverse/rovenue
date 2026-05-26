import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";

export interface BaseLayoutProps {
  t: TFunction;
  preview: string;
  unsubscribeUrl?: string;
  managePreferencesUrl: string;
  children: ReactNode;
}

const bodyStyle = {
  fontFamily: "system-ui, sans-serif",
  backgroundColor: "#f6f7f9",
  margin: 0,
  padding: 24,
} as const;

const cardStyle = {
  background: "white",
  borderRadius: 8,
  padding: 24,
  maxWidth: 560,
} as const;

const brandStyle = { fontSize: 18, fontWeight: 600, margin: 0 } as const;
const hrStyle = { borderColor: "#e5e7eb" } as const;
const footerLinkStyle = { fontSize: 12, color: "#6b7280" } as const;
const footerAddressStyle = {
  fontSize: 11,
  color: "#9ca3af",
  marginTop: 8,
} as const;

export function BaseLayout({
  t,
  preview,
  unsubscribeUrl,
  managePreferencesUrl,
  children,
}: BaseLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={cardStyle}>
          <Section>
            <Text style={brandStyle}>{t("footer.brand")}</Text>
          </Section>
          <Section>{children}</Section>
          <Hr style={hrStyle} />
          <Section>
            <Text style={footerLinkStyle}>
              <Link href={managePreferencesUrl}>{t("footer.manage")}</Link>
              {unsubscribeUrl ? (
                <>
                  {" · "}
                  <Link href={unsubscribeUrl}>{t("footer.unsubscribe")}</Link>
                </>
              ) : null}
            </Text>
            <Text style={footerAddressStyle}>{t("footer.address")}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
