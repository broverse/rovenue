import type { AppDescriptor } from "./types";

const lower = (value: string) => value.toLowerCase();

export const matchesQuery = (
  app: AppDescriptor,
  query: string,
  resolveText: (app: AppDescriptor) => ReadonlyArray<string>,
): boolean => {
  const term = query.trim();
  if (!term) return true;
  const needle = lower(term);
  return resolveText(app).some((haystack) => lower(haystack).includes(needle));
};

export const computeCategoryCounts = (apps: ReadonlyArray<AppDescriptor>) => {
  const out = {
    all: apps.length,
    connected: apps.filter((a) => a.status === "connected").length,
    attribution: 0,
    ads: 0,
    analytics: 0,
    data: 0,
    lifecycle: 0,
    communication: 0,
    automation: 0,
    identity: 0,
    billing: 0,
  };
  for (const app of apps) out[app.category] += 1;
  return out;
};
