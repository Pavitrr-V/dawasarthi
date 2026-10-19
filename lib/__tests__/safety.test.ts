import { describe, expect, it } from "vitest";
import { duplicateIngredients, allergyCheck } from "@/lib/safety-pure";

const dolo650 = {
  id: "m1",
  name: "Dolo 650",
  composition: [{ name: "Paracetamol", strength: "650mg" }],
  active: true,
};

const crocin = {
  id: "m2",
  name: "Crocin",
  composition: [{ name: "Paracetamol", strength: "500mg" }],
  active: true,
};

const neurobion = {
  id: "m3",
  name: "NEUROBION",
  composition: [
    { name: "Vitamin B1" },
    { name: "Vitamin B6" },
    { name: "Vitamin B12" },
  ],
  active: true,
};

const amox = {
  id: "m4",
  name: "Amoxicillin",
  composition: [{ name: "Amoxicillin" }],
  active: true,
};

const emptyComp = {
  id: "m5",
  name: "EmptyMed",
  composition: [],
  active: true,
};

describe("duplicateIngredients", () => {
  it("flags Dolo 650 + Crocin as duplicate paracetamol", () => {
    const warnings = duplicateIngredients([dolo650, crocin]);
    expect(warnings.length).toBeGreaterThan(0);
    const w = warnings[0];
    expect(w.type).toBe("duplicate");
    expect(w.message).toContain("Crocin and Dolo 650 both contain Paracetamol.");
    expect(w.message).toContain("Taking both can cause overdose. Ask your doctor or pharmacist.");
  });

  it("no false alarm between paracetamol and NEUROBION", () => {
    const warnings = duplicateIngredients([dolo650, neurobion]);
    expect(warnings.length).toBe(0);
  });

  it("deduplicates same medicine appearing twice", () => {
    const warnings = duplicateIngredients([dolo650, dolo650]);
    expect(warnings.length).toBe(0);
  });

  it("handles empty composition", () => {
    const warnings = duplicateIngredients([emptyComp]);
    expect(warnings.length).toBe(0);
  });
});

describe("allergyCheck", () => {
  it("matches allergy spelling variants (amoxicillin under penicillin)", () => {
    const warnings = allergyCheck({ id: "p1", allergies: ["penicillin"] }, amox.composition);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].type).toBe("allergy");
    expect(warnings[0].severity).toBe("severe");
  });

  it("matches sulfa synonym group", () => {
    const warnings = allergyCheck(
      { id: "p1", allergies: ["sulfa"] },
      [{ name: "Sulfamethoxazole" }]
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("matches aspirin/NSAIDs", () => {
    const warnings = allergyCheck(
      { id: "p1", allergies: ["aspirin"] },
      [{ name: "Acetylsalicylic Acid" }]
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("no allergy match with empty composition", () => {
    const warnings = allergyCheck({ id: "p1", allergies: ["penicillin"] }, []);
    expect(warnings.length).toBe(0);
  });
});
