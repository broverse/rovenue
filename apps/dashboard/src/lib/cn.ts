import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind class names — `clsx` for conditional joining, `twMerge`
 * for de-duplicating conflicting utility classes (e.g. `px-2 px-4` → `px-4`).
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
