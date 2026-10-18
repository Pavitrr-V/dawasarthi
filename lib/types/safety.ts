import { z } from "zod";

export const Severity = z.enum(["mild", "moderate", "severe", "unknown"]);
export type Severity = z.infer<typeof Severity>;

export const SafetySource = z.enum(["rules", "db", "ai"]);
export type SafetySource = z.infer<typeof SafetySource>;

export const SafetyWarningSchema = z.object({
  type: z.enum(["duplicate", "allergy", "interaction"]),
  severity: Severity,
  title: z.string().min(1),
  message: z.string().min(1),
  involved: z.array(z.string()).default([]),
  source: SafetySource,
  aiGenerated: z.boolean().optional(),
  sourceUrl: z.string().url().optional(),
  fetchedAt: z.string().datetime().optional(),
});
export type SafetyWarning = z.infer<typeof SafetyWarningSchema>;

export const SafetyCheckResultSchema = z.object({
  warnings: z.array(SafetyWarningSchema),
  hasActiveIssues: z.boolean(),
});
export type SafetyCheckResult = z.infer<typeof SafetyCheckResultSchema>;

export const InteractionPairSchema = z.object({
  id: z.string().uuid().optional(),
  drug_a: z.string().min(1),
  drug_b: z.string().min(1),
  severity: Severity.default("moderate"),
  note: z.string().min(1),
  reference: z.string().optional(),
  source_url: z.string().url().optional(),
  fetched_at: z.string().datetime().optional(),
});
export type InteractionPair = z.infer<typeof InteractionPairSchema>;

export const AILLMInteractionResponseSchema = z.object({
  interactions: z.array(
    z.object({
      drug_a: z.string().min(1),
      drug_b: z.string().min(1),
      severity: Severity,
      note: z.string().min(1),
    })
  ),
});
export type AILLMInteractionResponse = z.infer<typeof AILLMInteractionResponseSchema>;