import { ServiceProvider } from "impair";
import type { ReactNode } from "react";
import { PaywallBuilderApi } from "../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

interface Props {
  projectId: string;
  paywallId: string;
  children: ReactNode;
}

export function PaywallBuilderProvider({ projectId, paywallId, children }: Props) {
  return (
    <ServiceProvider
      provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
      props={{ projectId, paywallId }}
    >
      {children}
    </ServiceProvider>
  );
}
