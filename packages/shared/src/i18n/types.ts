// BCP47 tag, opaque
export type LocaleCode = string;

// Map of locale codes to values of type T
export type Localized<T> = { readonly [locale: LocaleCode]: T };

// Project locale configuration
export type LocaleSet = {
  default: LocaleCode;
  available: readonly LocaleCode[];
};
