import type { MedicineExtraction, ScanMode } from "@/lib/extraction";

/**
 * Hand-off from the scan screen to /scan/review. The extraction happens in
 * the browser, so the payload lives in sessionStorage (per tab) until the
 * user saves it. Nothing sensitive: the photos stay in Supabase storage and
 * only their paths travel here.
 */
export type ReviewPayload = {
  extraction: MedicineExtraction;
  mode: ScanMode;
  /** Storage paths of the uploaded photos (strip first, box second). */
  imagePaths: string[];
};

const REVIEW_KEY = "medscan:review:v1";

/** Blank extraction used by /scan/manual. Every field is empty. */
export const EMPTY_EXTRACTION: MedicineExtraction = {
  name: null,
  brand: null,
  composition: [],
  batch_no: null,
  mfg_date: null,
  expiry_date: null,
  mrp: null,
  license_no: null,
  manufacturer: null,
  barcode_text: null,
  storage_notes: null,
  date_precision: null,
  confidence: {},
};

function readFromSession(): ReviewPayload | null {
  try {
    const raw = sessionStorage.getItem(REVIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReviewPayload> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.extraction) return null;
    return {
      extraction: parsed.extraction,
      mode: parsed.mode ?? "medicine",
      imagePaths: Array.isArray(parsed.imagePaths)
        ? parsed.imagePaths.slice(0, 2)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * The loaded payload is cached so `getReviewPayload` can be used as a
 * useSyncExternalStore snapshot (it must return a stable reference).
 */
let cached: ReviewPayload | null | undefined;

/** Client snapshot: null when there is nothing to review in this tab. */
export function getReviewPayload(): ReviewPayload | null {
  if (cached === undefined) cached = readFromSession();
  return cached;
}

/** Server snapshot: the payload only exists in the browser. */
export function getReviewServerSnapshot(): undefined {
  return undefined;
}

export function saveReviewPayload(payload: ReviewPayload): void {
  cached = payload;
  try {
    sessionStorage.setItem(REVIEW_KEY, JSON.stringify(payload));
  } catch {
    // Storage full / private mode: the in-memory cache still covers this tab.
  }
}

export function clearReviewPayload(): void {
  cached = null;
  try {
    sessionStorage.removeItem(REVIEW_KEY);
  } catch {
    // Nothing to clean up.
  }
}
