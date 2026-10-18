import { describe, expect, it } from "vitest";
import {
  buildPrescriptionExtraction,
  medicineToSchedules,
  normalizeFreqToPattern,
  parsePattern,
  slotsToPattern3,
  slotsToTimes,
} from "@/lib/prescription";

describe("parsePattern", () => {
  it("parses 1-0-1 and 1-1-1", () => {
    expect(parsePattern("1-0-1")).toEqual([1, 0, 1]);
    expect(parsePattern("1-1-1")).toEqual([1, 1, 1]);
    expect(parsePattern("1/0/1")).toEqual([1, 0, 1]);
    expect(parsePattern("1 0 1")).toEqual([1, 0, 1]);
  });
  it("handles missing/invalid", () => {
    expect(parsePattern(null)).toEqual([0, 0, 0]);
    expect(parsePattern("X")).toEqual([0, 0, 0]);
  });
});

describe("slotsToPattern3", () => {
  it("maps valid slots", () => {
    expect(slotsToPattern3([1, 0, 1])).toBe("1-0-1");
    expect(slotsToPattern3([1, 1, 1])).toBe("1-1-1");
    expect(slotsToPattern3([1, 0, 0])).toBe("1-0-0");
    expect(slotsToPattern3([0, 0, 0])).toBe(null);
  });
});

describe("normalizeFreqToPattern", () => {
  it("normalizes common abbreviations", () => {
    expect(normalizeFreqToPattern("BD")).toBe("1-0-1");
    expect(normalizeFreqToPattern("bd")).toBe("1-0-1");
    expect(normalizeFreqToPattern("TDS")).toBe("1-1-1");
    expect(normalizeFreqToPattern("tds")).toBe("1-1-1");
    expect(normalizeFreqToPattern("OD")).toBe("1-0-0");
    expect(normalizeFreqToPattern("od")).toBe("1-0-0");
    expect(normalizeFreqToPattern("HS")).toBe("0-0-1");
    expect(normalizeFreqToPattern("hs")).toBe("0-0-1");
    expect(normalizeFreqToPattern("SOS")).toBe("1-0-0");
    expect(normalizeFreqToPattern("sos")).toBe("1-0-0");
  });
  it("returns null for unknown", () => {
    expect(normalizeFreqToPattern("M-I-W-F")).toBe(null);
  });
});

describe("slotsToTimes", () => {
  it("uses meal times with offsets", () => {
    const meal = { breakfast: "08:00", lunch: "14:00", dinner: "21:00" };
    expect(slotsToTimes([1, 0, 1], meal, "after_food")).toEqual(["08:30", "21:30"]);
    expect(slotsToTimes([1, 1, 1], meal, "before_food")).toEqual(["07:30", "13:30", "20:30"]);
    expect(slotsToTimes([0, 0, 1], meal, "any")).toEqual(["21:30"]);
  });
});

describe("medicineToSchedules", () => {
  it("creates schedule objects", () => {
    const med = {
      raw_text: "Paracetamol 500mg BD x 5 days",
      name: "Paracetamol",
      strength: "500mg",
      form: null,
      pattern: "1-0-1" as const,
      timing: "after_food" as const,
      duration_days: 5,
      instructions: "BD x 5 days after food",
      confidence: 0.9,
    };
    const s = medicineToSchedules(med, { breakfast: "08:00", lunch: "14:00", dinner: "21:00" });
    expect(s).toHaveLength(1);
    expect(s[0].times).toEqual(["08:30", "21:30"]);
    expect(s[0].pattern).toBe("1-0-1");
    expect(s[0].duration_days).toBe(5);
  });
});

describe("buildPrescriptionExtraction", () => {
  it("maps JSON to prescription structure", () => {
    const data = {
      doctor_name: "Dr. Test",
      date: "2026-10-18",
      patient_name: "John",
      medicines: [
        {
          raw_text: "Metformin 500mg 1-0-1 PC x 30 days",
          name: "Metformin",
          strength: "500mg",
          form: "tablet",
          pattern: "1-0-1",
          timing: "after_food",
          duration_days: 30,
          instructions: "1 tab BD after food",
          confidence: 0.95,
        },
      ],
    };
    const p = buildPrescriptionExtraction(data);
    expect(p?.doctor_name).toBe("Dr. Test");
    expect(p?.medicines).toHaveLength(1);
    expect(p?.medicines[0].pattern).toBe("1-0-1");
    expect(p?.medicines[0].timing).toBe("after_food");
    expect(p?.medicines[0].confidence).toBe(0.95);
  });
});
