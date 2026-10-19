import "server-only";

import { createClient } from "@/lib/supabase/server";
import { normalizeIngredient } from "@/lib/utils/normalize";
import type {
  SafetyCheckResult,
  SafetyWarning,
  InteractionPair,
} from "@/lib/types/safety";
import { llmInteractionCheck } from "@/lib/llm/safety-llm";

// Pure (no server deps) helpers are extracted to lib/safety-pure.ts so they
// can be unit-tested without "server-only". Re-exported here for callers.
import {
  duplicateIngredients,
  allergyCheck,
  type MedicineWithComp,
  type PatientWithAllergies,
} from "@/lib/safety-pure";

export { duplicateIngredients, allergyCheck };
export type { MedicineWithComp, PatientWithAllergies };

function isActiveMed(m: MedicineWithComp): boolean {
  return m.active !== false;
}

export async function interactionCheck(
  medicines: MedicineWithComp[]
): Promise<SafetyWarning[]> {
  const warnings: SafetyWarning[] = [];
  const active = medicines.filter(isActiveMed);
  if (active.length < 2) return warnings;

  const supabase = await createClient();

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
              message:
                r.note || "Potential interaction between these medicines.",
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
