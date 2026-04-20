import { useState } from "react";
import { Button } from "@heroui/react";
import { authClient } from "../../lib/auth";

const DEV_EMAIL = "dev@rovenue.local";
const DEV_PASSWORD = "devpass1234";
const DEV_NAME = "Dev User";

/**
 * Visible only in Vite dev mode. Posts to Better Auth's email+password
 * endpoints (which the API enables in non-production only) so you can
 * see the dashboard without registering an OAuth app.
 *
 * Strategy: try signIn first — fastest path for repeat dev runs —
 * and fall back to signUp when the account doesn't exist yet.
 */
export function DevLoginButton() {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loginOrCreate() {
    setPending(true);
    setError(null);
    try {
      const signIn = await authClient.signIn.email({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
      });
      if (signIn.error) {
        const signUp = await authClient.signUp.email({
          email: DEV_EMAIL,
          password: DEV_PASSWORD,
          name: DEV_NAME,
        });
        if (signUp.error) {
          throw new Error(signUp.error.message ?? "Dev sign-up failed");
        }
      }
      window.location.href = "/projects";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-default-400">
        <span className="h-px flex-1 bg-default-200" />
        <span>dev only</span>
        <span className="h-px flex-1 bg-default-200" />
      </div>
      <Button
        variant="ghost"
        className="w-full justify-center"
        isPending={isPending}
        onPress={loginOrCreate}
      >
        Continue as Dev User
      </Button>
      {error && (
        <div role="alert" className="text-sm text-danger-500">
          {error}
        </div>
      )}
    </div>
  );
}
