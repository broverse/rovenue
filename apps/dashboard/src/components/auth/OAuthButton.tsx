import { Button } from "@heroui/react";
import type { ReactNode } from "react";
import { signIn } from "../../lib/auth";

type Provider = "github" | "google";

interface Props {
  provider: Provider;
  children: ReactNode;
}

export function OAuthButton({ provider, children }: Props) {
  return (
    <Button
      variant="outline"
      className="w-full justify-center"
      onPress={() =>
        signIn.social({ provider, callbackURL: "/projects" })
      }
    >
      {children}
    </Button>
  );
}
