export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

export const sanitizeSlug = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9-]/g, "");

export const initials = (value: string): string =>
  value
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

export const guessNameFromEmail = (email: string): string =>
  email
    .split("@")[0]
    .replace(/[^a-z0-9]/gi, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
