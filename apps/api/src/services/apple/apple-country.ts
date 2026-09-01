// =============================================================
// Apple storefront -> ISO 3166-1 alpha-2 country (house format)
// =============================================================
//
// Apple's decoded JWS transaction carries `storefront` as an ISO
// 3166-1 ALPHA-3 code (e.g. "USA"). That is the ONLY alpha-3 country
// surface in this codebase: `raw_exposures.country` is fed from
// `apps/api/src/routes/v1/experiments.ts`'s `z.string().length(2)`,
// which is ALPHA-2, and Google/Stripe (../country.ts's
// `normalizeAlpha2Country`) both natively supply alpha-2. Storing
// Apple's value raw would put two
// formats of the same concept in the same analytics database —
// `"USA"` on revenue vs. `"US"` on exposures — so any join or
// comparison between the two silently splits one country into two
// buckets.
//
// Ruling: alpha-2 is the house format. Convert HERE, at the point the
// transaction is read (apple-webhook.ts / receipt-verify.ts), not at
// query time — pushing the conversion to readers means every future
// reader has to remember it, and one of them won't.
//
// The table below is the standard ISO 3166-1 alpha-3 -> alpha-2
// mapping (both forms are defined by the same standard for every
// entry; this is not an Apple-specific format, just its other
// representation). It holds all 249 officially assigned ISO 3166-1
// entries — a count pinned by apple-country.test.ts, because the table
// shipped with 222 and the 27 missing ones were dropping real revenue.
// It is still NOT a copy of Apple's own live storefront list: Apple may
// use a subset, and a territory Apple sells in that ISO has not assigned
// would not appear. `appleStorefrontToCountry` fails
// CLOSED on anything not in it: no country is recorded, never a guess
// and never the raw alpha-3 value. That mirrors the stance already
// taken on a store that supplies nothing at all, and on the
// subscriber's last-known SDK-reported country — an absent or wrong
// mapping must never masquerade as a real value.
const ISO_3166_ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = {
  AFG: "AF",
  ALB: "AL",
  DZA: "DZ",
  AND: "AD",
  AGO: "AO",
  AIA: "AI",
  ATG: "AG",
  ARG: "AR",
  ARM: "AM",
  ABW: "AW",
  AUS: "AU",
  AUT: "AT",
  AZE: "AZ",
  BHS: "BS",
  BHR: "BH",
  BGD: "BD",
  BRB: "BB",
  BLR: "BY",
  BEL: "BE",
  BLZ: "BZ",
  BEN: "BJ",
  BMU: "BM",
  BTN: "BT",
  BOL: "BO",
  BIH: "BA",
  BWA: "BW",
  BRA: "BR",
  VGB: "VG",
  BRN: "BN",
  BGR: "BG",
  BFA: "BF",
  BDI: "BI",
  KHM: "KH",
  CMR: "CM",
  CAN: "CA",
  CPV: "CV",
  CYM: "KY",
  CAF: "CF",
  TCD: "TD",
  CHL: "CL",
  CHN: "CN",
  COL: "CO",
  COM: "KM",
  COG: "CG",
  COD: "CD",
  COK: "CK",
  CRI: "CR",
  CIV: "CI",
  HRV: "HR",
  CUB: "CU",
  CYP: "CY",
  CZE: "CZ",
  DNK: "DK",
  DJI: "DJ",
  DMA: "DM",
  DOM: "DO",
  ECU: "EC",
  EGY: "EG",
  SLV: "SV",
  GNQ: "GQ",
  ERI: "ER",
  EST: "EE",
  SWZ: "SZ",
  ETH: "ET",
  FRO: "FO",
  FJI: "FJ",
  FIN: "FI",
  FRA: "FR",
  GUF: "GF",
  PYF: "PF",
  GAB: "GA",
  GMB: "GM",
  GEO: "GE",
  DEU: "DE",
  GHA: "GH",
  GIB: "GI",
  GRC: "GR",
  GRL: "GL",
  GRD: "GD",
  GLP: "GP",
  GUM: "GU",
  GTM: "GT",
  GGY: "GG",
  GIN: "GN",
  GNB: "GW",
  GUY: "GY",
  HTI: "HT",
  HND: "HN",
  HKG: "HK",
  HUN: "HU",
  ISL: "IS",
  IND: "IN",
  IDN: "ID",
  IRN: "IR",
  IRQ: "IQ",
  IRL: "IE",
  IMN: "IM",
  ISR: "IL",
  ITA: "IT",
  JAM: "JM",
  JPN: "JP",
  JEY: "JE",
  JOR: "JO",
  KAZ: "KZ",
  KEN: "KE",
  KIR: "KI",
  PRK: "KP",
  KOR: "KR",
  KWT: "KW",
  KGZ: "KG",
  LAO: "LA",
  LVA: "LV",
  LBN: "LB",
  LSO: "LS",
  LBR: "LR",
  LBY: "LY",
  LIE: "LI",
  LTU: "LT",
  LUX: "LU",
  MAC: "MO",
  MDG: "MG",
  MWI: "MW",
  MYS: "MY",
  MDV: "MV",
  MLI: "ML",
  MLT: "MT",
  MHL: "MH",
  MTQ: "MQ",
  MRT: "MR",
  MUS: "MU",
  MEX: "MX",
  FSM: "FM",
  MDA: "MD",
  MCO: "MC",
  MNG: "MN",
  MNE: "ME",
  MSR: "MS",
  MAR: "MA",
  MOZ: "MZ",
  MMR: "MM",
  NAM: "NA",
  NRU: "NR",
  NPL: "NP",
  NLD: "NL",
  NCL: "NC",
  NZL: "NZ",
  NIC: "NI",
  NER: "NE",
  NGA: "NG",
  NIU: "NU",
  MKD: "MK",
  NOR: "NO",
  OMN: "OM",
  PAK: "PK",
  PLW: "PW",
  PSE: "PS",
  PAN: "PA",
  PNG: "PG",
  PRY: "PY",
  PER: "PE",
  PHL: "PH",
  POL: "PL",
  PRT: "PT",
  PRI: "PR",
  QAT: "QA",
  REU: "RE",
  ROU: "RO",
  RUS: "RU",
  RWA: "RW",
  KNA: "KN",
  LCA: "LC",
  VCT: "VC",
  WSM: "WS",
  SMR: "SM",
  STP: "ST",
  SAU: "SA",
  SEN: "SN",
  SRB: "RS",
  SYC: "SC",
  SLE: "SL",
  SGP: "SG",
  SVK: "SK",
  SVN: "SI",
  SLB: "SB",
  SOM: "SO",
  ZAF: "ZA",
  SSD: "SS",
  ESP: "ES",
  LKA: "LK",
  SDN: "SD",
  SUR: "SR",
  SWE: "SE",
  CHE: "CH",
  SYR: "SY",
  TWN: "TW",
  TJK: "TJ",
  TZA: "TZ",
  THA: "TH",
  TLS: "TL",
  TGO: "TG",
  TON: "TO",
  TTO: "TT",
  TUN: "TN",
  TUR: "TR",
  TKM: "TM",
  TCA: "TC",
  TUV: "TV",
  UGA: "UG",
  UKR: "UA",
  ARE: "AE",
  GBR: "GB",
  USA: "US",
  URY: "UY",
  UZB: "UZ",
  VUT: "VU",
  VAT: "VA",
  VEN: "VE",
  VNM: "VN",
  VIR: "VI",
  YEM: "YE",
  ZMB: "ZM",
  ZWE: "ZW",

  // --- entries missing from the original transcription -------------
  // Added 2026-09-01. The table above shipped with 222 of ISO 3166-1's
  // 249 officially assigned entries; these are the other 27. Because
  // `ALPHA2_COUNTRY_CODES` is derived from this table's VALUES, their
  // absence also made `../country.ts` reject a genuine Google/Stripe
  // billing country — several of these are real store countries
  // (CW, SX, MP, AS, YT, AX), so fail-closed was dropping real revenue
  // and the loss was then misattributed to the store coverage matrix.
  //
  // Mostly dependencies and outlying territories, which is why a
  // hand-typed list of "countries" skipped them. Kept as one block
  // rather than merged into the alphabetical run above so the
  // completion is visible and re-checkable.
  //
  // Source: ISO 3166-1, alpha-3/alpha-2 pairs as published in the ISO
  // Online Browsing Platform (https://www.iso.org/obp/ui/#search/code/),
  // cross-checked against the UN M49 country/area listing. Count pinned
  // by apple-country.test.ts.
  ALA: "AX", // Åland Islands
  ASM: "AS", // American Samoa
  ATA: "AQ", // Antarctica
  BES: "BQ", // Bonaire, Sint Eustatius and Saba
  BVT: "BV", // Bouvet Island
  IOT: "IO", // British Indian Ocean Territory
  CXR: "CX", // Christmas Island
  CCK: "CC", // Cocos (Keeling) Islands
  CUW: "CW", // Curaçao
  FLK: "FK", // Falkland Islands (Malvinas)
  ATF: "TF", // French Southern Territories
  HMD: "HM", // Heard Island and McDonald Islands
  MYT: "YT", // Mayotte
  NFK: "NF", // Norfolk Island
  MNP: "MP", // Northern Mariana Islands
  PCN: "PN", // Pitcairn
  BLM: "BL", // Saint Barthélemy
  SHN: "SH", // Saint Helena, Ascension and Tristan da Cunha
  MAF: "MF", // Saint Martin (French part)
  SPM: "PM", // Saint Pierre and Miquelon
  SXM: "SX", // Sint Maarten (Dutch part)
  SGS: "GS", // South Georgia and the South Sandwich Islands
  SJM: "SJ", // Svalbard and Jan Mayen
  TKL: "TK", // Tokelau
  UMI: "UM", // United States Minor Outlying Islands
  WLF: "WF", // Wallis and Futuna
  ESH: "EH", // Western Sahara
};

/**
 * Normalises a store-supplied storefront/country code to the house
 * ISO 3166-1 alpha-2 format. Returns `null` (fail closed) for a
 * missing, blank, or unrecognised code — never the raw input and
 * never a guess. Case-insensitive on the input; output is always
 * upper-case alpha-2.
 */
export function appleStorefrontToCountry(
  storefront: string | null | undefined,
): string | null {
  if (!storefront) return null;
  const alpha2 = ISO_3166_ALPHA3_TO_ALPHA2[storefront.trim().toUpperCase()];
  return alpha2 ?? null;
}

/**
 * The set of house-format ISO 3166-1 alpha-2 codes — every VALUE in the
 * alpha-3 -> alpha-2 table above, which is a complete ISO 3166-1 alpha-2
 * enumeration in its own right (both forms are defined by the same
 * standard entry for entry, and the table's completeness is pinned by
 * apple-country.test.ts). Exported so `../country.ts`'s
 * `normalizeAlpha2Country` — used to validate Google's and Stripe's
 * already-alpha-2 store-supplied country fields — has exactly ONE
 * source of truth for "is this a real ISO 3166-1 alpha-2 code" rather
 * than a second, independently-maintained list that could drift from
 * this one.
 */
export const ALPHA2_COUNTRY_CODES: ReadonlySet<string> = new Set(
  Object.values(ISO_3166_ALPHA3_TO_ALPHA2),
);
