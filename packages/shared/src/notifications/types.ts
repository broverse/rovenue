import { z } from "zod";

export const NotificationChannel = z.enum(["email", "push", "inapp"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const PushPlatform = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

export const NotificationDeliveryStatus = z.enum([
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
]);
export type NotificationDeliveryStatus = z.infer<
  typeof NotificationDeliveryStatus
>;

export const MemberRoleName = z.enum([
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
]);
export type MemberRoleName = z.infer<typeof MemberRoleName>;

export type RecipientScope =
  | { kind: "self" }
  | { kind: "project_roles"; roles: MemberRoleName[] }
  | { kind: "project_members" }
  | { kind: "workspace_owner" };

export interface NotificationEventDescriptor {
  key: string;
  category: "revenue" | "billing" | "integration" | "team" | "security";
  defaultChannels: NotificationChannel[];
  forcedChannels: NotificationChannel[];
  defaultEnabled: boolean;
  recipientScope: RecipientScope;
  contextSchema: z.ZodTypeAny;
  pushAllowed: boolean;
}
