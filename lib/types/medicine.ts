import { z } from "zod";

export const TrustColor = z.enum(["green", "amber", "red"]);
export type TrustColor = z.infer<typeof TrustColor>;

export const CompositionItemSchema = z.object({
  name: z.string().min(1),
  strength: z.string().optional(),
});
export type CompositionItem = z.infer<typeof CompositionItemSchema>;

export const MedicineCompositionSchema = z
  .array(CompositionItemSchema)
  .optional()
  .nullable();

export const InventorySchema = z
  .object({
    id: z.string().uuid().optional(),
    medicine_id: z.string().uuid().optional(),
    quantity: z.number().int().min(0).optional(),
    low_stock_threshold: z.number().int().min(0).optional(),
    unit: z.string().min(1).optional(),
    updated_at: z.string().datetime().optional(),
  })
  .nullable()
  .optional();

export const MedicineSchema = z.object({
  id: z.string().uuid(),
  patient_id: z.string().uuid(),
  name: z.string().min(1),
  trust_color: TrustColor,
  expiry_date: z.string().date().nullable().optional(),
  quantity: z.number().int().min(0).optional(),
  low_stock_threshold: z.number().int().min(0).optional(),
  unit: z.string().min(1).optional(),
  composition: MedicineCompositionSchema,
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  inventory: InventorySchema,
  active: z.boolean().optional().default(true),
});
export type Medicine = z.infer<typeof MedicineSchema>;

export const PatientAllergiesSchema = z
  .array(z.string().min(1))
  .optional()
  .nullable();
export type PatientAllergies = z.infer<typeof PatientAllergiesSchema>;

export const PatientSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  allergies: PatientAllergiesSchema,
});
export type Patient = z.infer<typeof PatientSchema>;