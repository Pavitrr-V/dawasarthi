import { ingredientKey, normalizeIngredient } from "@/lib/utils/normalize";
import { buildAllergyMatcher } from "@/lib/data/allergy-synonyms";
import type { SafetyWarning } from "@/lib/types/safety";
import type { Medicine, Patient } from "@/lib/types/medicine";

export type MedicineWithComp = Pick<
  Medicine,
  "id" | "name" | "composition" | "active"
> & {
  active?: boolean;
};

export type PatientWithAllergies = Pick<Patient, "id" | "allergies">;

function isActiveMed(m: MedicineWithComp): boolean {
  return m.active !== false;
}

export function duplicateIngredients(
  medicines: MedicineWithComp[]
): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];
  const ingToMeds = new Map<string, Set<string>>();

  for (const m of medicines) {
    if (!isActiveMed(m)) continue;
    const comp = m.composition || [];
    for (const c of comp) {
      const k = ingredientKey(c.name);
      if (!k) continue;
      if (!ingToMeds.has(k)) ingToMeds.set(k, new Set());
      ingToMeds.get(k)!.add(m.name);
    }
  }

  for (const [ing, namesSet] of ingToMeds) {
    const names = Array.from(namesSet).filter(Boolean);
    if (names.length >= 2) {
      const involved = names.slice().sort((a, b) => a.localeCompare(b));
      const ingDisplay = ing
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      const title = "Duplicate active ingredient";
      const message = `${involved.join(" and ")} both contain ${ingDisplay}. Taking both can cause overdose. Ask your doctor or pharmacist.`;
      warnings.push({
        type: "duplicate",
        severity: "severe",
        title,
        message,
        involved: [ingDisplay, ...involved],
        source: "rules",
      });
    }
  }
  return warnings;
}

export function allergyCheck(
  patient: PatientWithAllergies | null | undefined,
  composition: MedicineWithComp["composition"] | null | undefined
): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];
  const allergies = patient?.allergies || [];
  if (!allergies.length || !composition || composition.length === 0) {
    return warnings;
  }

  const matcher = buildAllergyMatcher();
  const compList = composition || [];

  for (const a of allergies) {
    const aNorm = normalizeIngredient(a);
    const aCanon = matcher.get(aNorm) || matcher.get(a.toLowerCase().trim());
    for (const c of compList) {
      const cNorm = normalizeIngredient(c.name);
      const cCanon = matcher.get(cNorm);
      const match =
        (!!aCanon && !!cCanon && aCanon === cCanon) ||
        (!!aCanon && cNorm.includes(aCanon)) ||
        (!!cCanon && aNorm.includes(cCanon)) ||
        cNorm === aNorm;

      if (match) {
        warnings.push({
          type: "allergy",
          severity: "severe",
          title: "Allergy warning (RED)",
          message: `Allergy to ${a} may be triggered by ${c.name}. Ask your doctor or pharmacist.`,
          involved: [c.name, a],
          source: "rules",
        });
      }
    }
  }
  return warnings;
}
