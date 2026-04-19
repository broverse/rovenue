import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { OAuthButton } from "../components/auth/OAuthButton";

export const Route = createFileRoute("/login")({
  component: LoginRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
});

function LoginRouteComponent() {
  const { error } = Route.useSearch();
  return <LoginPage error={error} />;
}

export function LoginPage({ error }: { error?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md p-6">
        <div className="mb-4 flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Sign in to Rovenue</h1>
          <p className="text-sm text-default-500">
            Continue with GitHub or Google to manage your projects.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {error && (
            <div
              role="alert"
              className="rounded-md bg-danger-100 px-3 py-2 text-sm text-danger-700"
            >
              {error}
            </div>
          )}
          <OAuthButton provider="github">Continue with GitHub</OAuthButton>
          <OAuthButton provider="google">Continue with Google</OAuthButton>
        </div>
      </Card>
    </div>
  );
}
