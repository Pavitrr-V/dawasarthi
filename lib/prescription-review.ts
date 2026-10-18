/**
 * Prescription review helpers — pure, no server imports.
 *
 * Shared by /scan/prescription/review (client) and its tests. Everything here
 * is deterministic: converting the LLM's prescription lines into editable rows,
 * counting reminders, and picking the earliest dose time using the patient's
 * meal times.
 *
 * Time zone: clock times are Asia/Kolkata (UTC+05:30, fixed no DST).
 */

import {
  parsePattern,
  slotsToTimes,
  type DosePattern3,
  type MealTiming,
  type PrescriptionExtraction,
  type PrescriptionMedicine,
} from "@/lib/prescription";
import type { MealTimes } from "@/lib/schedule";

/** Below this a medicine row must be double-checked by a human. */
export const PRESCRIPTION_CONFIDENCE_THRESHOLD = 0.7;

/** Editable row on the prescription review screen. */
export type ReviewRow = {
  /** Stable React key (generated client-side). */
  id: string;
  raw_text: string;
  name: string;
  strength: string;
  form: string;
  /** Dose pattern ("1-0-1") or "" when unknown. */
  pattern: string;
  timing: MealTiming | "";
  /** Days to take, as a string so the <input> can hold "". */
  duration_days: string;
  instructions: string;
  /** Tablet count for the cabinet ("" = do not track stock). */
  tablet_count: string;
  /** Original LLM confidence for this line (0..1). */
  confidence: number;
  /** User ticked "I verified this line". */
  verified: boolean;
};

/** Pattern choices for the <select>. */
export const PATTERN_OPTIONS: DosePattern3[] = [
  "1-0-0",
  "0-1-0",
  "0-0-1",
  "1-1-0",
  "1-0-1",
  "0-1-1",
  "1-1-1",
];

/** Timing choices for the <select>. */
export const TIMING_OPTIONS: MealTiming[] = [
  "before_food",
  "after_food",
  "with_food",
  "any",
];

let rowCounter = 0;
function newRowId(): string {
  rowCounter += 1;
  return `row-${rowCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** How many tablets the default stock is: doses/day * duration (min 1 day). */
export function defaultTabletCount(row: Pick<ReviewRow, "pattern" | "duration_days">): number {
  const slots = parsePattern(row.pattern);
  const perDay = slots[0] + slots[1] + slots[2];
  const days = Number(row.duration_days);
  const duration = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  return Math.max(perDay * duration, 1);
}

function medicineToRow(med: PrescriptionMedicine): ReviewRow {
  const slots = parsePattern(med.pattern);
  const perDay = slots[0] + slots[1] + slots[2];
  const duration = med.duration_days ?? null;
  return {
    id: newRowId(),
    raw_text: med.raw_text,
    name: med.name ?? "",
    strength: med.strength ?? "",
    form: med.form ?? "",
    pattern: med.pattern ?? "",
    timing: med.timing ?? "",
    duration_days: duration === null ? "" : String(duration),
    instructions: med.instructions ?? "",
    tablet_count:
      perDay > 0 && duration !== null ? String(defaultTabletCount({ pattern: med.pattern ?? "", duration_days: String(duration) })) : "",
    confidence: med.confidence,
    verified: false,
  };
}

/** Turn the LLM's prescription lines into editable rows (one per medicine). */
export function initialRowsFromExtraction(
  extraction: PrescriptionExtraction
): ReviewRow[] {
  return extraction.medicines.map(medicineToRow);
}

/** A blank row appended with the "Add medicine" button. */
export function emptyRow(): ReviewRow {
  return {
    id: newRowId(),
    raw_text: "",
    name: "",
    strength: "",
    form: "",
    pattern: "",
    timing: "",
    duration_days: "",
    instructions: "",
    tablet_count: "",
    confidence: 1,
    verified: true,
  };
}

/** True when a row must be ticked "verified" before it can be saved. */
export function needsVerify(row: ReviewRow): boolean {
  return row.confidence < PRESCRIPTION_CONFIDENCE_THRESHOLD;
}

/** Doses per day from a pattern ("1-0-1" -> 2). */
export function patternDosesPerDay(pattern: string): number {
  const slots = parsePattern(pattern);
  return slots[0] + slots[1] + slots[2];
}

/** "08:00" -> "8:00 AM". */
export function formatClock12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  const ampm = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${ampm}`;
}

export type PrescriptionSummary = {
  total: number;
  remindersPerDay: number;
  /** Earliest clock time across all rows, already using the meal offsets. */
  firstReminder: { hhmm: string; label: string } | null;
};

/**
 * Live summary shown above the confirm button: total medicines, total
 * reminders per day, and the earliest reminder time (computed with the
 * patient's meal times so it matches what will actually be scheduled).
 */
export function computeSummary(rows: ReviewRow[], mealTimes: MealTimes): PrescriptionSummary {
  let remindersPerDay = 0;
  let earliest: string | null = null;

  for (const row of rows) {
    remindersPerDay += patternDosesPerDay(row.pattern);
    const slots = parsePattern(row.pattern);
    const times = slotsToTimes(slots, mealTimes, row.timing || null);
    for (const time of times) {
      if (earliest === null || time < earliest) earliest = time;
    }
  }

  return {
    total: rows.length,
    remindersPerDay,
    firstReminder: earliest
      ? { hhmm: earliest, label: formatClock12(earliest) }
      : null,
  };
}

/**
 * True when every row has a name and a pattern, and every low-confidence row
 * has been ticked "verified". The confirm button stays disabled until this is
 * true.
 */
export function rowsAreSavable(rows: ReviewRow[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const hasName = row.name.trim().length > 0;
    const hasPattern = row.pattern.trim().length > 0;
    const verified = !needsVerify(row) || row.verified;
    return hasName && hasPattern && verified;
  });
}

/* ------------------------------------------------------------------ */
/* sessionStorage hand-off from /scan to /scan/prescription/review    */
/* ------------------------------------------------------------------ */

export type PrescriptionReviewPayload = {
  extraction: PrescriptionExtraction;
  /** Storage paths of the uploaded prescription photo(s). */
  imagePaths: string[];
};

const PRESCRIPTION_KEY = "medscan:prescription-review:v1";

function readFromSession(): PrescriptionReviewPayload | null {
  try {
    const raw = sessionStorage.getItem(PRESCRIPTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PrescriptionReviewPayload> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.extraction) return null;
    return {
      extraction: parsed.extraction,
      imagePaths: Array.isArray(parsed.imagePaths)
        ? parsed.imagePaths.slice(0, 2)
        : [],
    };
  } catch {
    return null;
  }
}

let cached: PrescriptionReviewPayload | null | undefined;

/** Client snapshot: null when there is nothing to review in this tab. */
export function getPrescriptionReviewPayload(): PrescriptionReviewPayload | null {
  if (cached === undefined) cached = readFromSession();
  return cached;
}

/** Server snapshot: the payload only exists in the browser. */
export function getPrescriptionReviewServerSnapshot(): undefined {
  return undefined;
}

export function savePrescriptionReviewPayload(
  payload: PrescriptionReviewPayload
): void {
  cached = payload;
  try {
    sessionStorage.setItem(PRESCRIPTION_KEY, JSON.stringify(payload));
  } catch {
    // Storage full / private mode: the in-memory cache still covers this tab.
  }
}

export function clearPrescriptionReviewPayload(): void {
  cached = null;
  try {
    sessionStorage.removeItem(PRESCRIPTION_KEY);
  } catch {
    // Nothing to clean up.
  }
}
