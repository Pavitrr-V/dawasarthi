import { describe, expect, it } from "vitest";
import {
  PRESCRIPTION_CONFIDENCE_THRESHOLD,
  computeSummary,
  defaultTabletCount,
  formatClock12,
  initialRowsFromExtraction,
  needsVerify,
  patternDosesPerDay,
  rowsAreSavable,
  type ReviewRow,
} from "@/lib/prescription-review";
import type { PrescriptionExtraction } from "@/lib/prescription";

const MEALS = { breakfast: "08:00", lunch: "14:00", dinner: "21:00" };

function row(overrides: Partial<ReviewRow>): ReviewRow {
  return {
    id: "r1",
    raw_text: "",
    name: "Paracetamol",
    strength: "500mg",
    form: "tablet",
    pattern: "1-0-1",
    timing: "after_food",
    duration_days: "5",
    instructions: "",
    tablet_count: "",
    confidence: 1,
    verified: true,
    ...overrides,
  };
}

describe("patternDosesPerDay", () => {
  it("sums the slots", () => {
    expect(patternDosesPerDay("1-0-1")).toBe(2);
    expect(patternDosesPerDay("1-1-1")).toBe(3);
    expect(patternDosesPerDay("1-0-0")).toBe(1);
    expect(patternDosesPerDay("")).toBe(0);
  });
});

describe("formatClock12", () => {
  it("formats 12-hour clock", () => {
    expect(formatClock12("08:00")).toBe("8:00 AM");
    expect(formatClock12("20:30")).toBe("8:30 PM");
    expect(formatClock12("12:00")).toBe("12:00 PM");
    expect(formatClock12("00:15")).toBe("12:15 AM");
  });
});

describe("defaultTabletCount", () => {
  it("is doses/day * duration", () => {
    expect(defaultTabletCount({ pattern: "1-0-1", duration_days: "5" })).toBe(10);
    expect(defaultTabletCount({ pattern: "1-1-1", duration_days: "7" })).toBe(21);
  });
  it("falls back to 1 day when duration is missing", () => {
    expect(defaultTabletCount({ pattern: "1-0-0", duration_days: "" })).toBe(1);
  });
});

describe("computeSummary", () => {
  it("counts medicines, reminders/day, and earliest time", () => {
    const rows = [
      row({ pattern: "1-0-1", timing: "after_food" }),
      row({ id: "r2", pattern: "1-0-0", timing: "before_food" }),
    ];
    const summary = computeSummary(rows, MEALS);
    expect(summary.total).toBe(2);
    expect(summary.remindersPerDay).toBe(3);
    // 1-0-0 before_food -> 07:30, 1-0-1 after_food -> 08:30 & 21:30; earliest 07:30.
    expect(summary.firstReminder?.hhmm).toBe("07:30");
    expect(summary.firstReminder?.label).toBe("7:30 AM");
  });

  it("is null firstReminder with no valid patterns", () => {
    const summary = computeSummary([row({ pattern: "" })], MEALS);
    expect(summary.remindersPerDay).toBe(0);
    expect(summary.firstReminder).toBeNull();
  });
});

describe("needsVerify / rowsAreSavable", () => {
  it("flags low-confidence rows", () => {
    expect(needsVerify(row({ confidence: PRESCRIPTION_CONFIDENCE_THRESHOLD - 0.01 }))).toBe(true);
    expect(needsVerify(row({ confidence: 0.9 }))).toBe(false);
  });

  it("blocks save until low-confidence rows are verified", () => {
    const low = row({ confidence: 0.5, verified: false });
    expect(rowsAreSavable([low])).toBe(false);
    expect(rowsAreSavable([{ ...low, verified: true }])).toBe(true);
  });

  it("requires a name and pattern", () => {
    expect(rowsAreSavable([row({ name: "" })])).toBe(false);
    expect(rowsAreSavable([row({ pattern: "" })])).toBe(false);
    expect(rowsAreSavable([])).toBe(false);
  });
});

describe("initialRowsFromExtraction", () => {
  it("maps every medicine line to an editable row", () => {
    const extraction: PrescriptionExtraction = {
      doctor_name: "Dr. A",
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
          instructions: "after food",
          confidence: 0.5,
        },
      ],
    };
    const rows = initialRowsFromExtraction(extraction);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Metformin");
    expect(rows[0].pattern).toBe("1-0-1");
    expect(rows[0].duration_days).toBe("30");
    expect(rows[0].confidence).toBe(0.5);
    expect(rows[0].verified).toBe(false);
    expect(needsVerify(rows[0])).toBe(true);
  });
});
