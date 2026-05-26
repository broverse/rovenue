import { z } from "zod";

export const UpdateUserChannelsBody = z.object({
  scope: z.literal("global"),
  channels: z
    .object({ email: z.boolean().optional(), push: z.boolean().optional() })
    .optional(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export const UpdateUserProjectOverridesBody = z.object({
  scope: z.literal("project"),
  projectId: z.string().min(1),
  overrides: z.record(z.string(), z.boolean()),
});

export const UpdatePreferencesBody = z.discriminatedUnion("scope", [
  UpdateUserChannelsBody,
  UpdateUserProjectOverridesBody,
]);
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

export const RegisterPushDeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  token: z.string().min(1).max(4096),
  appBundleId: z.string().min(1).max(256),
  locale: z.string().min(2).max(10),
  timezone: z.string().min(1).max(64),
});
export type RegisterPushDeviceBody = z.infer<typeof RegisterPushDeviceBody>;

export const UnsubscribeBody = z.object({ token: z.string().min(20) });

export const ProjectNotificationDefaultsBody = z.object({
  defaults: z.record(z.string(), z.boolean()),
});

export const ListFeedQuery = z.object({
  unread: z.coerce.boolean().optional(),
  projectId: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListFeedQuery = z.infer<typeof ListFeedQuery>;
