import { describe, expect, it } from "vitest";
import {
  adherenceLabel,
  adherenceTone,
  computeAdherence,
  isCountedStatus,
} from "@/lib/adherence";
import type { DoseStatus } from "@/lib/types";

describe("computeAdherence", () => {
  it("returns a null percent when there is nothing to measure", () => {
    expect(computeAdherence([])).toEqual({
      taken: 0,
      missed: 0,
      skipped: 0,
      total: 0,
      percent: null,
    });
  });

  it("ignores pending and snoozed doses", () => {
    const statuses: DoseStatus[] = ["pending", "snoozed", "snoozed", "pending"];
    expect(computeAdherence(statuses)).toEqual({
      taken: 0,
      missed: 0,
      skipped: 0,
      total: 0,
      percent: null,
    });
  });

  it("counts taken, missed and skipped toward the total", () => {
    const result = computeAdherence(["taken", "taken", "missed", "skipped"]);
    expect(result).toEqual({
      taken: 2,
      missed: 1,
      skipped: 1,
      total: 4,
      percent: 50,
    });
  });

  it("rounds the percentage to the nearest whole number", () => {
    expect(computeAdherence(["taken", "taken", "missed"]).percent).toBe(67);
    expect(computeAdherence(["taken", "missed", "missed"]).percent).toBe(33);
  });

  it("is 100% when every resolved dose was taken", () => {
    expect(computeAdherence(["taken", "taken", "taken"]).percent).toBe(100);
  });

  it("is 0% when nothing was taken but doses were resolved", () => {
    expect(computeAdherence(["missed", "skipped"]).percent).toBe(0);
  });

  it("mixes ignored and counted statuses correctly", () => {
    expect(computeAdherence(["pending", "taken", "snoozed", "skipped"])).toEqual({
      taken: 1,
      missed: 0,
      skipped: 1,
      total: 2,
      percent: 50,
    });
  });
});

describe("adherenceLabel", () => {
  it("shows a percentage when there is data", () => {
    expect(adherenceLabel(computeAdherence(["taken", "missed"]))).toBe("50%");
  });

  it("says No data yet when the denominator is zero", () => {
    expect(adherenceLabel(computeAdherence([]))).toBe("No data yet");
  });
});

describe("adherenceTone", () => {
  it("is none without data", () => {
    expect(adherenceTone(computeAdherence([]))).toBe("none");
  });

  it("is green at 80% and above", () => {
    expect(adherenceTone(computeAdherence(["taken", "taken", "taken", "taken", "missed"]))).toBe(
      "green"
    );
  });

  it("is amber between 50% and 79%", () => {
    expect(adherenceTone(computeAdherence(["taken", "missed"]))).toBe("amber");
  });

  it("is red below 50%", () => {
    expect(adherenceTone(computeAdherence(["taken", "missed", "missed"]))).toBe("red");
  });
});

describe("isCountedStatus", () => {
  it("counts resolved doses and ignores the rest", () => {
    expect(isCountedStatus("taken")).toBe(true);
    expect(isCountedStatus("missed")).toBe(true);
    expect(isCountedStatus("skipped")).toBe(true);
    expect(isCountedStatus("pending")).toBe(false);
    expect(isCountedStatus("snoozed")).toBe(false);
  });
});
