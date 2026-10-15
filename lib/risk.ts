/**
 * Deterministic medicine risk engine.
 *
 * `evaluateRisk` takes everything MedScan knows about a medicine (pack fields,
 * the other face of the pack, catalog / community / official-alert / online
 * signals) and returns a Green-Amber-Red verdict with a plain-language
 * explanation in English and Hindi.
 *
 * It is a *pure* function: no network, no storage, no clock read unless the
 * caller passes `today`. The LLM and TinyFish only ever extract or fetch data;
 * the verdict is decided here, entirely by rules, so it is reproducible and
 * directly unit-testable.
 */

export type RiskLevel = "green" | "amber" | "red";

/** INFO never raises the level; AMBER and RED do. */
export type RiskSeverity = "info" | "amber" | "red";

export type ExpiryStatus = "expired" | "expiring_soon" | "valid" | "unknown";

export type RiskReason = {
  /** Stable, machine-readable identifier (safe to switch on / i18n later). */
  code: string;
  severity: RiskSeverity;
  message_en: string;
  message_hi: string;
  /** Present when the reason is backed by a web source (alert / online check). */
  source_url?: string;
};

export type RiskResult = {
  /** Worst severity across all reasons; "green" when there are none. */
  level: RiskLevel;
  /** Sorted RED -> AMBER -> INFO. */
  reasons: RiskReason[];
};

/** One row from `nsq_alerts`, already matched against this medicine. */
export type AlertMatch = {
  alert_type: string;
  product_name: string;
  batch_no: string | null;
  /** ISO date (YYYY-MM-DD) as stored in `nsq_alerts.alert_date`. */
  alert_date: string;
  source_url: string;
  matchType: "name_and_batch" | "name_only";
};

export type OnlineCheckStatus = "pending" | "found" | "not_found" | "error";

/** Row from `online_verifications` (TinyFish web check). */
export type OnlineCheck = {
  status: OnlineCheckStatus;
  listed_mrp?: number | null;
  listed_manufacturer?: string | null;
  source_url?: string | null;
  /** 0..1 confidence from the fetch/extraction. */
  confidence?: number | null;
};

/** The other face of the pack (the box when the primary capture was the strip). */
export type PackSide = {
  name?: string | null;
  batch_no?: string | null;
  expiry_date?: string | null;
};

export type RiskInput = {
  name?: string | null;
  composition?: string[] | null;
  batch_no?: string | null;
  mfg_date?: string | null;
  expiry_date?: string | null;
  mrp?: number | null;
  license_no?: string | null;
  manufacturer?: string | null;

  /** Second side of the pack, for strip-vs-box cross-checking. */
  secondSide?: PackSide | null;

  /** `false` = the scanned code was not found in `medicine_catalog`. */
  datasetMatch?: boolean | null;
  /** How many users have reported a problem with this medicine. */
  communityReportCount?: number | null;

  /** "Now". Injected so results are deterministic in tests. */
  today?: Date;

  alertMatches?: AlertMatch[] | null;
  onlineCheck?: OnlineCheck | null;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Expiring within this many days is an AMBER warning. */
export const EXPIRING_SOON_DAYS = 30;
/** Online facts below this confidence are ignored. */
export const ONLINE_CONFIDENCE_MIN = 0.7;
/** MRP differs by more than this fraction (either direction) -> AMBER. */
export const MRP_TOLERANCE = 0.15;

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  red: 0,
  amber: 1,
  info: 2,
};

const ALERT_TYPE_LABELS: Record<string, string> = {
  nsq: "Not of standard quality",
  spurious: "Spurious",
  adulterated: "Adulterated",
  misbranded: "Misbranded",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABELS[type] ?? type;
}

/** Parse a strict "YYYY-MM-DD" into a UTC-midnight epoch, or null. */
function parseIsoDate(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Reject calendar roll-overs such as 2026-02-31.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/** Midnight (UTC) of the reference day, so day maths ignores the clock time. */
function startOfDayUtc(today: Date): number {
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

/** Whole days from `today` to `expiryDate`; negative = already expired. */
export function daysToExpiry(
  expiryDate: string | null | undefined,
  today: Date = new Date()
): number | null {
  const expiry = parseIsoDate(expiryDate);
  if (expiry === null) return null;
  return Math.round((expiry - startOfDayUtc(today)) / MS_PER_DAY);
}

/** Expiry bucket used by the UI. */
export function expiryStatus(
  expiryDate: string | null | undefined,
  today: Date = new Date()
): ExpiryStatus {
  const days = daysToExpiry(expiryDate, today);
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= EXPIRING_SOON_DAYS) return "expiring_soon";
  return "valid";
}

function isBlankText(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Lowercase, keep only letters/digits, collapse separators to single spaces. */
function normalizeText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Batch comparison ignores case and every separator ("abc/123" == "ABC-123"). */
function normalizeBatch(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True only when both sides carry a value and they differ. */
function differs(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && a !== b;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Evaluate the risk of a medicine. Pure and deterministic: identical input
 * (including `today`) always yields identical output.
 */
export function evaluateRisk(input: RiskInput): RiskResult {
  const today = input.today ?? new Date();
  const reasons: RiskReason[] = [];

  // --- Expiry -----------------------------------------------------------
  const expiryDays = daysToExpiry(input.expiry_date, today);
  if (expiryDays !== null && expiryDays < 0) {
    reasons.push({
      code: "EXPIRED",
      severity: "red",
      message_en: `This medicine expired on ${input.expiry_date}. Do not use it.`,
      message_hi: `यह दवा ${input.expiry_date} को एक्सपायर हो गई है। इसे न लें।`,
    });
  } else if (expiryDays !== null && expiryDays <= EXPIRING_SOON_DAYS) {
    reasons.push({
      code: "EXPIRING_SOON",
      severity: "amber",
      message_en: `This medicine will expire soon (on ${input.expiry_date}).`,
      message_hi: `यह दवा जल्द ही (${input.expiry_date} को) एक्सपायर हो जाएगी।`,
    });
  }

  // --- Manufacturing date sanity ---------------------------------------
  const mfgMs = parseIsoDate(input.mfg_date);
  const expiryMs = parseIsoDate(input.expiry_date);
  if (mfgMs !== null && expiryMs !== null && mfgMs > expiryMs) {
    reasons.push({
      code: "MFG_AFTER_EXPIRY",
      severity: "red",
      message_en:
        "The manufacturing date is after the expiry date. The printing may be wrong — please check the pack.",
      message_hi:
        "बनाने की तारीख एक्सपायरी तारीख के बाद है। छपाई गलत हो सकती है — कृपया पैक पर जाँचें।",
    });
  }
  if (mfgMs !== null && mfgMs > startOfDayUtc(today)) {
    reasons.push({
      code: "MFG_IN_FUTURE",
      severity: "red",
      message_en:
        "The manufacturing date is in the future. The printing may be wrong — please check the pack.",
      message_hi:
        "बनाने की तारीख भविष्य की है। छपाई गलत हो सकती है — कृपया पैक पर जाँचें।",
    });
  }

  // --- Missing mandatory fields (one reason per field) ------------------
  if (isBlankText(input.batch_no)) {
    reasons.push({
      code: "MISSING_BATCH",
      severity: "amber",
      message_en: "Batch number is missing. Please check the pack.",
      message_hi: "बैच नंबर नहीं मिला। कृपया पैक पर जाँचें।",
    });
  }
  if (isBlankText(input.mfg_date)) {
    reasons.push({
      code: "MISSING_MFG_DATE",
      severity: "amber",
      message_en: "Manufacturing date is missing. Please check the pack.",
      message_hi: "बनाने की तारीख नहीं मिली। कृपया पैक पर जाँचें।",
    });
  }
  if (isBlankText(input.license_no)) {
    reasons.push({
      code: "MISSING_LICENSE",
      severity: "amber",
      message_en: "License number is missing. Please check the pack.",
      message_hi: "लाइसेंस नंबर नहीं मिला। कृपया पैक पर जाँचें।",
    });
  }
  if (!isNumber(input.mrp)) {
    reasons.push({
      code: "MISSING_MRP",
      severity: "amber",
      message_en: "MRP is missing. Please check the pack.",
      message_hi: "एमआरपी (MRP) नहीं मिली। कृपया पैक पर जाँचें।",
    });
  }

  // --- Batch number sanity (soft warning only) --------------------------
  if (!isBlankText(input.batch_no)) {
    const batch = input.batch_no!.trim();
    const validShape = /^[A-Za-z0-9\-/]{3,15}$/.test(batch);
    const core = batch.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const allSame = core.length > 1 && new Set(core).size === 1;
    if (!validShape || allSame) {
      reasons.push({
        code: "BATCH_FORMAT",
        severity: "amber",
        message_en:
          "The batch number looks unusual. Please check it on the pack.",
        message_hi: "बैच नंबर सामान्य नहीं लगता। कृपया इसे पैक पर जाँचें।",
      });
    }
  }

  // --- Strip vs box cross-check ----------------------------------------
  const side = input.secondSide;
  if (side) {
    if (differs(normalizeText(input.name), normalizeText(side.name))) {
      reasons.push({
        code: "PACK_NAME_MISMATCH",
        severity: "red",
        message_en:
          "The strip and the box show different medicine names. Please check both.",
        message_hi:
          "स्ट्रिप और बॉक्स पर दवा का नाम अलग है। कृपया दोनों जाँचें।",
      });
    }
    if (differs(normalizeBatch(input.batch_no), normalizeBatch(side.batch_no))) {
      reasons.push({
        code: "PACK_BATCH_MISMATCH",
        severity: "red",
        message_en:
          "The strip and the box show different batch numbers. Please check both.",
        message_hi:
          "स्ट्रिप और बॉक्स पर बैच नंबर अलग है। कृपया दोनों जाँचें।",
      });
    }
    const primaryExpiry = parseIsoDate(input.expiry_date);
    const sideExpiry = parseIsoDate(side.expiry_date);
    if (
      primaryExpiry !== null &&
      sideExpiry !== null &&
      primaryExpiry !== sideExpiry
    ) {
      reasons.push({
        code: "PACK_EXPIRY_MISMATCH",
        severity: "red",
        message_en:
          "The strip and the box show different expiry dates. Please check both.",
        message_hi:
          "स्ट्रिप और बॉक्स पर एक्सपायरी तारीख अलग है। कृपया दोनों जाँचें।",
      });
    }
  }

  // --- Catalog membership ----------------------------------------------
  if (input.datasetMatch === false) {
    reasons.push({
      code: "NOT_IN_DATASET",
      severity: "amber",
      message_en:
        "This medicine was not found in our reference list. Please double-check it.",
      message_hi:
        "यह दवा हमारी संदर्भ सूची में नहीं मिली। कृपया इसे दोबारा जाँचें।",
    });
  }

  // --- Community reports ------------------------------------------------
  const reports = isNumber(input.communityReportCount)
    ? Math.max(0, Math.floor(input.communityReportCount))
    : 0;
  if (reports >= 3) {
    reasons.push({
      code: "COMMUNITY_REPORTS_HIGH",
      severity: "red",
      message_en: `Several people reported a problem with this medicine (${reports} reports).`,
      message_hi: `कई लोगों ने इस दवा की समस्या बताई है (${reports} रिपोर्ट)।`,
    });
  } else if (reports >= 1) {
    reasons.push({
      code: "COMMUNITY_REPORTS",
      severity: "amber",
      message_en: `Other people reported a problem with this medicine (${reports} report${reports === 1 ? "" : "s"}).`,
      message_hi: `अन्य लोगों ने इस दवा की समस्या बताई है (${reports} रिपोर्ट)।`,
    });
  }

  // --- Official (NSQ) alerts -------------------------------------------
  let nameOnlyAlertAdded = false;
  for (const alert of input.alertMatches ?? []) {
    if (alert.matchType === "name_and_batch") {
      reasons.push({
        code: "ALERT_BATCH_MATCH",
        severity: "red",
        message_en: `Official safety alert for this batch: ${alertTypeLabel(alert.alert_type)} on ${alert.alert_date}.`,
        message_hi: `इस बैच के लिए आधिकारिक सुरक्षा चेतावनी: ${alertTypeLabel(alert.alert_type)}, ${alert.alert_date}।`,
        source_url: alert.source_url,
      });
    } else if (alert.matchType === "name_only" && !nameOnlyAlertAdded) {
      // Never changes the colour; the batch itself is not listed.
      nameOnlyAlertAdded = true;
      reasons.push({
        code: "ALERT_OTHER_BATCH",
        severity: "info",
        message_en:
          "Other batches of this medicine had an alert; your batch is not listed.",
        message_hi:
          "इस दवा के अन्य बैचों पर चेतावनी थी; आपका बैच सूची में नहीं है।",
        source_url: alert.source_url,
      });
    }
  }

  // --- Online (TinyFish) verification ----------------------------------
  const online = input.onlineCheck;
  if (online) {
    const source = online.source_url ?? undefined;

    if (online.status === "found") {
      const confident =
        isNumber(online.confidence) && online.confidence >= ONLINE_CONFIDENCE_MIN;
      if (confident) {
        // Scanned MRP vs listed MRP (either direction, > 15%).
        if (isNumber(input.mrp) && input.mrp > 0 && isNumber(online.listed_mrp)) {
          const change = Math.abs(online.listed_mrp - input.mrp) / input.mrp;
          if (change > MRP_TOLERANCE) {
            reasons.push({
              code: "MRP_MISMATCH",
              severity: "amber",
              message_en:
                "The MRP on the pack does not match the online listing.",
              message_hi: "पैक पर लिखी एमआरपी ऑनलाइन सूची से मेल नहीं खाती।",
              ...(source ? { source_url: source } : {}),
            });
          }
        }
        if (
          differs(
            normalizeText(input.manufacturer),
            normalizeText(online.listed_manufacturer)
          )
        ) {
          reasons.push({
            code: "MANUFACTURER_MISMATCH",
            severity: "amber",
            message_en:
              "The manufacturer on the pack does not match the online listing.",
            message_hi:
              "पैक पर लिखा निर्माता ऑनलाइन सूची से मेल नहीं खाता।",
            ...(source ? { source_url: source } : {}),
          });
        }
      }
    } else if (online.status === "not_found") {
      reasons.push({
        code: "ONLINE_NOT_FOUND",
        severity: "amber",
        message_en:
          "This medicine was not found online. Please double-check it.",
        message_hi: "यह दवा ऑनलाइन नहीं मिली। कृपया इसे दोबारा जाँचें।",
        ...(source ? { source_url: source } : {}),
      });
    } else if (online.status === "pending") {
      reasons.push({
        code: "ONLINE_PENDING",
        severity: "info",
        message_en: "Online check not completed.",
        message_hi: "ऑनलाइन जाँच पूरी नहीं हुई।",
      });
    } else if (online.status === "error") {
      reasons.push({
        code: "ONLINE_ERROR",
        severity: "info",
        message_en: "Online check not completed.",
        message_hi: "ऑनलाइन जाँच पूरी नहीं हुई।",
      });
    }
  }

  // --- Verdict: worst severity wins; INFO never raises the level --------
  const sorted = reasons
    .map((reason, index) => ({ reason, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.reason.severity] - SEVERITY_RANK[b.reason.severity] ||
        a.index - b.index
    )
    .map((entry) => entry.reason);

  const level: RiskLevel = sorted.some((r) => r.severity === "red")
    ? "red"
    : sorted.some((r) => r.severity === "amber")
      ? "amber"
      : "green";

  return { level, reasons: sorted };
}
