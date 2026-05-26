import { z } from "zod";

export const themeSchema = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111111"),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3b82f6"),
  background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0f172a"),
  font_family: z.string().optional(),
  logo_url: z.string().url().optional(),
});

export type Theme = z.infer<typeof themeSchema>;

export const settingsSchema = z.object({
  app_store_url: z.string().url().optional(),
  play_store_url: z.string().url().optional(),
  universal_link_domain: z.string().regex(/^[a-z0-9.-]+$/).optional(),
  deep_link_scheme: z.string().regex(/^[a-z][a-z0-9+\-.]*$/).optional(),
  dev_mode: z.boolean().default(false),
});

export type FunnelSettings = z.infer<typeof settingsSchema>;
