import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ingredientKey, normalizeIngredient } from "@/lib/utils/normalize";
import { buildAllergyMatcher } from "@/lib/data/allergy-synonyms";
import type {
  SafetyCheckResult,
  SafetyWarning,
  InteractionPair,
} from "@/lib/types/safety";
import type { Medicine, Patient } from "@/lib/types/medicine";
import { llmInteractionCheck } from "@/lib/llm/safety-llm";

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
      const message = `${involved.join(" and ")} both contain ${ingDisplay}; taking both can cause overdose.`;
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
          message: `Allergy to ${a} may be triggered by ${c.name}.`,
          involved: [c.name, a],
          source: "rules",
        });
      }
    }
  }
  return warnings;
}

export async function interactionCheck(
  medicines: MedicineWithComp[]
): Promise<SafetyWarning[]> {
  const warnings: SafetyWarning[] = [];
  const active = medicines.filter(isActiveMed);
  if (active.length < 2) return warnings;

  const supabase = createSupabaseServerClient();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const aMed = active[i];
      const bMed = active[j];
      const aKeys = new Set<string>();
      const bKeys = new Set<string>();
      if (aMed.name) aKeys.add(normalizeIngredient(aMed.name));
      if (bMed.name) bKeys.add(normalizeIngredient(bMed.name));
      (aMed.composition || []).forEach((c) =>
        aKeys.add(normalizeIngredient(c.name))
      );
      (bMed.composition || []).forEach((c) =>
        bKeys.add(normalizeIngredient(c.name))
      );

      const { data: rows, error } = await supabase
        .from("interaction_pairs")
        .select(
          "id, drug_a, drug_b, severity, note, reference, source_url, fetched_at"
        )
        .or(
          `and(drug_a.eq.${aMed.name},drug_b.eq.${bMed.name}),and(drug_a.eq.${bMed.name},drug_b.eq.${aMed.name})`
        );

      if (error) {
        console.error(
          "[safety] interaction_pairs query error:",
          error.message,
          error.code
        );
      }

      if (rows && rows.length > 0) {
        for (const r of rows as InteractionPair[]) {
          const na = normalizeIngredient(r.drug_a);
          const nb = normalizeIngredient(r.drug_b);
          const hasA = Array.from(aKeys).some(
            (k) => k === na || k.includes(na) || na.includes(k)
          );
          const hasB = Array.from(bKeys).some(
            (k) => k === nb || k.includes(nb) || nb.includes(k)
          );
          const hasSwap =
            Array.from(aKeys).some(
              (k) => k === nb || k.includes(nb) || nb.includes(k)
            ) &&
            Array.from(bKeys).some(
              (k) => k === na || k.includes(na) || na.includes(k)
            );
          if (hasA && hasB || hasSwap) {
            warnings.push({
              type: "interaction",
              severity: (r.severity as any) || "moderate",
              title: "Drug-drug interaction",
              message: r.note || "Potential interaction between these medicines.",
              involved: [aMed.name, bMed.name],
              source: "db",
              sourceUrl: r.source_url,
              fetchedAt: r.fetched_at,
            });
          }
        }
      }
    }
  }

  if (warnings.length > 0) return warnings;

  try {
    const llmRes = await llmInteractionCheck(
      active.map((m) => ({ name: m.name }))
    );
    if (llmRes && Array.isArray(llmRes.interactions)) {
      for (const it of llmRes.interactions) {
        warnings.push({
          type: "interaction",
          severity: (it.severity as any) || "unknown",
          title: "Drug-drug interaction (AI-assisted)",
          message: `${it.note} — AI-generated, verify with pharmacist.`,
          involved: [it.drug_a, it.drug_b],
          source: "ai",
          aiGenerated: true,
        });
      }
    }
  } catch {
    // ignore
  }

  return warnings;
}

export async function runAllSafetyChecks(params: {
  patient?: PatientWithAllergies | null;
  medicines: MedicineWithComp[];
}): Promise<SafetyCheckResult> {
  const warnings: SafetyWarning[] = [];

  warnings.push(...duplicateIngredients(params.medicines));

  const active = params.medicines.filter(isActiveMed);
  for (const m of active) {
    warnings.push(...allergyCheck(params.patient, m.composition));
  }

  warnings.push(...(await interactionCheck(params.medicines)));

  return {
    warnings,
    hasActiveIssues: warnings.length > 0,
  };
}