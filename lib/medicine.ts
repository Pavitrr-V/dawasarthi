import { z } from "zod";

/**
 * Shape the review/manual form submits. Deliberately plain strings so a
 * manual entry and an extraction review both go through exactly one code
 * path (and one server action) on save.
 */
export type MedicineInput = {
  name: string;
  composition: string[];
  batch_no: string | null;
  mfg_date: string | null;
  expiry_date: string | null;
  mrp: number | null;
  license_no: string | null;
  manufacturer: string | null;
  barcode_text: string | null;
  storage_notes: string | null;
  strip_image_path: string | null;
  box_image_path: string | null;
  mode: "medicine" | "prescription" | "barcode";
  /** "scan" = reviewed an extraction, "manual" = typed from scratch. */
  source: "scan" | "manual";
  /** Raw LLM field confidence, stored for the risk engine (Phase 3). */
  confidence: Record<string, number>;
  /**
   * Barcode flow only: did the scanned code match medicine_catalog?
   * `false` is an AMBER risk flag in Phase 3. Absent for photo/manual entries.
   */
  dataset_match?: boolean;
};

/** Below this an extracted field must be double-checked by a human. */
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * A field needs verification when the extraction confidence is missing/null
 * or below the threshold. Shared by the review form and (later) the risk
 * engine so both always agree on which fields are uncertain.
 */
export function needsVerification(
  confidence: Record<string, number>,
  field: string
): boolean {
  const value = confidence[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  return value < CONFIDENCE_THRESHOLD;
}

export function flaggedFields(confidence: Record<string, number>): string[] {
  return Object.keys(confidence).filter((field) =>
    needsVerification(confidence, field)
  );
}

/** Optional free text: "", null and undefined all become null. */
const nullableText = (max: number) =>
  z
    .union([
      z.string().max(max, { error: `Maximum ${max} characters.` }),
      z.null(),
    ])
    .transform((value) => {
      if (value === null) return null;
      const text = value.trim();
      return text.length > 0 ? text : null;
    });

/** Optional YYYY-MM-DD date from <input type="date">: "" or null -> null. */
const nullableDate = (label: string) =>
  z
    .union([
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
        error: `${label} must be a valid date.`,
      }),
      z.literal(""),
      z.null(),
    ])
    .transform((value) => (value === null || value === "" ? null : value));

/**
 * Validates the review/manual form on the server. Never trust the client:
 * a Server Action is reachable by direct POST.
 */
export const medicineInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Please enter the medicine name." })
      .max(120, { error: "Name is too long." }),
    composition: z
      .array(z.string().trim().min(1).max(80, { error: "Ingredient too long." }))
      .max(30, { error: "Too many ingredients." })
      .default([]),
    batch_no: nullableText(60),
    mfg_date: nullableDate("Manufacturing date"),
    expiry_date: nullableDate("Expiry date"),
    mrp: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.coerce
        .number({ error: "MRP must be a number." })
        .min(0, { error: "MRP cannot be negative." })
        .max(1_000_000, { error: "MRP looks too large." })
        .optional()
    ),
    license_no: nullableText(60),
    manufacturer: nullableText(120),
    barcode_text: nullableText(60),
    storage_notes: nullableText(240),
    strip_image_path: nullableText(400),
    box_image_path: nullableText(400),
    mode: z.enum(["medicine", "prescription", "barcode"]),
    source: z.enum(["scan", "manual"]).default("scan"),
    confidence: z.record(z.string(), z.number()).default({}),
    dataset_match: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.mfg_date &&
      value.expiry_date &&
      value.expiry_date < value.mfg_date
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expiry_date"],
        message: "Expiry date cannot be before the manufacturing date.",
      });
    }
  });
