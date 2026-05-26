import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

export interface PushDevice {
  id: string;
  platform: "ios" | "android";
  appBundleId: string;
  locale: string;
  timezone: string;
  lastSeenAt: string;
  createdAt: string;
}

interface ListResponse {
  items: PushDevice[];
}

export interface RegisterPushDeviceInput {
  platform: "ios" | "android";
  token: string;
  appBundleId: string;
  locale?: string;
  timezone?: string;
}

const KEY = ["push-devices"] as const;

export function usePushDevices() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<ListResponse>("/dashboard/push-devices"),
    select: (r) => r.items,
  });
}

export function useRegisterPushDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterPushDeviceInput) =>
      api<PushDevice>("/dashboard/push-devices", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useRevokePushDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // The endpoint returns 204 No Content; api() expects a JSON
      // envelope, so we go straight to fetch and trust the status.
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? "http://localhost:3000"}/dashboard/push-devices/${id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok && res.status !== 204) {
        throw new Error(`Revoke failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
