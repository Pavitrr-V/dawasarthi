/**
 * Prescription parsing — pure helpers.
 *
 * Shared by the Gemini extract route and the schedule-building UI, so it must
 * stay importable from both the browser and Node. Nothing here touches
 * Supabase or the LLM; the LLM only extracts raw_text / confidence, the risk
 * and schedule conversion are decided deterministically here.
 *
 * Time zone: clock times are Asia/Kolkata (UTC+05:30, fixed no DST).
 */

import { resolveMealTime, type MealLink, type MealTimes } from "@/lib/schedule";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export const MEAL_OFFSETS = {
  before_food: "before",
  after_food: "after",
  with_food: "after",
  any: "after",
} as const;

export type MealTiming = "before_food" | "after_food" | "with_food" | "any";

export type DosePattern3 =
  | "0-0-0"
  | "1-0-0"
  | "0-1-0"
  | "0-0-1"
  | "1-1-0"
  | "1-0-1"
  | "0-1-1"
  | "1-1-1";

export type PrescriptionSchedule = {
  /** Clock times in Asia/Kolkata (HH:MM) derived from slots + meal timing. */
  times: string[];
  /** The 3-slot pattern used to derive times (morning-afternoon-night). */
  pattern: DosePattern3 | null;
  /** Meal link used for the schedule, when all doses share one meal context. */
  meal_link: MealLink | null;
  /** Number of days to take, if specified. */
  duration_days: number | null;
  /** Raw instructions preserved. */
  instructions: string | null;
};

export type PrescriptionMedicine = {
  raw_text: string;
  name: string | null;
  strength: string | null;
  form: string | null;
  pattern: DosePattern3 | null;
  timing: MealTiming | null;
  duration_days: number | null;
  instructions: string | null;
  confidence: number;
};

export type PrescriptionExtraction = {
  doctor_name: string | null;
  date: string | null;
  patient_name: string | null;
  medicines: PrescriptionMedicine[];
};

/* ------------------------------------------------------------------ */
/* Pattern parsing                                                    */
/* ------------------------------------------------------------------ */

/** "1-0-1" -> [1,0,1]; "1 0 1" / "1/0/1" also work; invalid -> [0,0,0]. */
export function parsePattern(pattern: string | null | undefined): [number, number, number] {
  if (!pattern) return [0, 0, 0];
  const m = /^(\d+)[\s\-_/.,]+(\d+)[\s\-_/.,]+(\d+)(?:[\s\-_/.,]+(\d+))?$/.exec(pattern.trim());
  if (!m) return [0, 0, 0];
  const a = Math.max(0, Math.min(9, parseInt(m[1], 10) || 0));
  const b = Math.max(0, Math.min(9, parseInt(m[2], 10) || 0));
  const c = Math.max(0, Math.min(9, parseInt(m[3], 10) || 0));
  return [a, b, c];
}

const VALID_PATTERNS: DosePattern3[] = [
  "0-0-0", "1-0-0", "0-1-0", "0-0-1", "1-1-0", "1-0-1", "0-1-1", "1-1-1",
];

/** Map 3 slots to a valid pattern key, or null when the slots are all zero. */
export function slotsToPattern3(slots: [number, number, number]): DosePattern3 | null {
  const [m, a, n] = slots;
  const key = `${m}-${a}-${n}` as DosePattern3;
  return VALID_PATTERNS.includes(key) && key !== "0-0-0" ? key : null;
}

/** Common frequency tokens -> 3-slot patterns. */
const FREQ_TOKENS: Array<[RegExp, DosePattern3]> = [
  [/^\s*o\.?d\.?\s*$/i, "1-0-0"],
  [/^\s*once\s*daily\s*/i, "1-0-0"],
  [/^\s*b\.?d\.?\s*$/i, "1-0-1"],
  [/^\s*bid\s*/i, "1-0-1"],
  [/^\s*twice\s*daily\s*/i, "1-0-1"],
  [/^\s*t\.?d\.?s\.?\s*$/i, "1-1-1"],
  [/^\s*tid\s*/i, "1-1-1"],
  [/^\s*thrice\s*daily\s*/i, "1-1-1"],
  [/^\s*q\.?i\.?d\.?\s*$/i, "1-1-1"],
  [/^\s*four\s*times\s*daily\s*/i, "1-1-1"],
  [/^\s*h\.?s\.?\s*$/i, "0-0-1"],
  [/^\s*bedtime\s*/i, "0-0-1"],
  [/^\s*s\.?o\.?s\.?\s*$/i, "1-0-0"],
  [/^\s*prn\s*/i, "1-0-0"],
];

/** Normalize BD/TDS/OD/QID/HS/SOS etc. to a pattern; null when unknown. */
export function normalizeFreqToPattern(text: string | null | undefined): DosePattern3 | null {
  if (!text) return null;
  for (const [re, pat] of FREQ_TOKENS) {
    if (re.test(text)) return pat;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Slot -> clock times                                                */
/* ------------------------------------------------------------------ */

function mealLinkForSlot(slotIndex: 0 | 1 | 2, timing: MealTiming | null): MealLink {
  const when = timing ? MEAL_OFFSETS[timing] : "after";
  const meal = slotIndex === 0 ? "breakfast" : slotIndex === 1 ? "lunch" : "dinner";
  return `${when}_${meal}` as MealLink;
}

/** Turn slots + timing + patient meal times into sorted HH:MM clock times. */
export function slotsToTimes(
  slots: [number, number, number],
  mealTimes: MealTimes,
  timing: MealTiming | null
): string[] {
  const out: string[] = [];
  if (slots[0] > 0) out.push(resolveMealTime(mealLinkForSlot(0, timing), mealTimes));
  if (slots[1] > 0) out.push(resolveMealTime(mealLinkForSlot(1, timing), mealTimes));
  if (slots[2] > 0) out.push(resolveMealTime(mealLinkForSlot(2, timing), mealTimes));
  return out;
}

function getSingleSlot(slots: [number, number, number]): 0 | 1 | 2 {
  if (slots[0] > 0) return 0;
  if (slots[1] > 0) return 1;
  return 2;
}

/* ------------------------------------------------------------------ */
/* Medicine -> schedule                                               */
/* ------------------------------------------------------------------ */

function parseDurationDays(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /\b(\d{1,2})\s*(day|days|week|weeks|month|months)\b/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  let d = n;
  if (unit.startsWith("week")) d = n * 7;
  if (unit.startsWith("month")) d = n * 30;
  if (d < 1) return null;
  return Math.min(d, 365);
}

/** Convert one prescription medicine line into a single schedule object. */
export function medicineToSchedules(
  med: PrescriptionMedicine,
  mealTimes: MealTimes
): PrescriptionSchedule[] {
  const slots = parsePattern(med.pattern);
  const pattern = slotsToPattern3(slots);
  const times = slotsToTimes(slots, mealTimes, med.timing);
  const duration = med.duration_days ?? parseDurationDays(med.instructions);
  const meal_link = times.length === 1 ? mealLinkForSlot(getSingleSlot(slots), med.timing) : null;
  return [
    {
      times,
      pattern,
      meal_link,
      duration_days: duration,
      instructions: med.instructions,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Gemini JSON schema + prompt                                        */
/* ------------------------------------------------------------------ */

export const PRESCRIPTION_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    doctor_name: { type: "STRING", nullable: true },
    date: { type: "STRING", nullable: true },
    patient_name: { type: "STRING", nullable: true },
    medicines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          raw_text: { type: "STRING" },
          name: { type: "STRING", nullable: true },
          strength: { type: "STRING", nullable: true },
          form: { type: "STRING", nullable: true },
          pattern: { type: "STRING", nullable: true },
          timing: { type: "STRING", nullable: true },
          duration_days: { type: "NUMBER", nullable: true },
          instructions: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" },
        },
        required: ["raw_text", "confidence"],
      },
    },
  },
  required: ["doctor_name", "date", "patient_name", "medicines"],
} as const;

export const PRESCRIPTION_SYSTEM_INSTRUCTION = [
  "You are reading a doctor prescription (printed or handwritten, Indian format).",
  "Extract each medicine line. Never guess illegible words: set confidence low and keep the raw_text.",
  "Dose patterns like 1-0-1 or 1-1-1 mean morning-afternoon-night counts; interpret BD, TDS, OD, QID, HS, SOS, AC (before food), PC (after food).",
  "Return dates as YYYY-MM-DD.",
  "Do not give medical advice, dosage, or diagnosis.",
].join(" ");

export function buildPrescriptionUserPrompt(): string {
  return "This photo is a prescription. Read the doctor's name, date, patient name, and every medicine line with its raw_text, name, strength, form, pattern, timing, duration_days, instructions, and confidence. Return the structured JSON object described by the schema.";
}

/* ------------------------------------------------------------------ */
/* Parsing / normalization                                            */
/* ------------------------------------------------------------------ */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = Math.floor(v);
    return d >= 0 && d <= 365 ? d : null;
  }
  return null;
}

function normalizeTiming(t: unknown): MealTiming | null {
  if (typeof t !== "string") return null;
  const v = t.toLowerCase().trim();
  return v === "before_food" || v === "after_food" || v === "with_food" || v === "any"
    ? (v as MealTiming)
    : null;
}

function mapMedicine(m: unknown): PrescriptionMedicine | null {
  if (!m || typeof m !== "object") return null;
  const obj = m as Record<string, unknown>;
  const raw = typeof obj.raw_text === "string" ? obj.raw_text : "";
  if (!raw.trim()) return null;
  const patternStr = typeof obj.pattern === "string" ? obj.pattern : null;
  const slots = parsePattern(patternStr);
  const pattern =
    slotsToPattern3(slots) ??
    normalizeFreqToPattern(raw) ??
    null;
  return {
    raw_text: raw,
    name: textOrNull(obj.name),
    strength: textOrNull(obj.strength),
    form: textOrNull(obj.form),
    pattern,
    timing: normalizeTiming(obj.timing),
    duration_days: numOrNull(obj.duration_days),
    instructions: textOrNull(obj.instructions),
    confidence: clamp01(typeof obj.confidence === "number" ? obj.confidence : 0),
  };
}

/** Map Gemini's parsed JSON object to a PrescriptionExtraction, or null. */
export function buildPrescriptionExtraction(data: unknown): PrescriptionExtraction | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const medicines = Array.isArray(obj.medicines) ? obj.medicines : [];
  return {
    doctor_name: textOrNull(obj.doctor_name),
    date: dateOrNull(obj.date),
    patient_name: textOrNull(obj.patient_name),
    medicines: medicines.map(mapMedicine).filter((m): m is PrescriptionMedicine => m !== null),
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Parse Gemini's text response into a PrescriptionExtraction, or null. */
export function parsePrescriptionJson(text: string): PrescriptionExtraction | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  return buildPrescriptionExtraction(json);
}
