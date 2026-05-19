import { useMutation } from "@tanstack/react-query";
import { ApiError } from "../api";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * Fetches the GDPR Art. 15 dump and drives a browser download.
 * We can't fall back to a bare `<a href download>` here because
 * Better Auth's session cookie only rides on fetches with
 * `credentials: "include"` — the navigation form drops it.
 */
export function useExportMe() {
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE_URL}/dashboard/me/export`, {
        credentials: "include",
      });
      if (!res.ok) {
        const envelope = (await res.json().catch(() => null)) as
          | { error?: { code: string; message: string } }
          | null;
        throw new ApiError(
          envelope?.error?.code ?? `HTTP_${res.status}`,
          envelope?.error?.message ?? res.statusText,
          res.status,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `rovenue-account-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      return { ok: true as const };
    },
  });
}
