import { describe, expect, it } from "vitest";
import {
  dayPartOf,
  groupByDayPart,
  istClockLabel,
  snoozeDueAt,
} from "@/lib/schedule";

// IST is UTC+05:30 (fixed, no DST). Build instants from an IST wall-clock time.
function ist(time: string): string {
  return new Date(`2026-06-01T${time}:00+05:30`).toISOString();
}

describe("day parts", () => {
  it("buckets IST times into Morning / Afternoon / Evening / Night", () => {
    expect(dayPartOf(ist("03:59"))).toBe("Night");
    expect(dayPartOf(ist("04:00"))).toBe("Morning");
    expect(dayPartOf(ist("11:59"))).toBe("Morning");
    expect(dayPartOf(ist("12:00"))).toBe("Afternoon");
    expect(dayPartOf(ist("16:59"))).toBe("Afternoon");
    expect(dayPartOf(ist("17:00"))).toBe("Evening");
    expect(dayPartOf(ist("20:59"))).toBe("Evening");
    expect(dayPartOf(ist("21:00"))).toBe("Night");
  });

  it("formats IST clock labels", () => {
    expect(istClockLabel(ist("08:05"))).toBe("8:05 am");
    expect(istClockLabel(ist("12:00"))).toBe("12:00 pm");
    expect(istClockLabel(ist("21:30"))).toBe("9:30 pm");
    expect(istClockLabel(ist("00:00"))).toBe("12:00 am");
  });

  it("groups in Morning -> Night order and drops empty buckets", () => {
    const doses = [
      { id: "evening", due_at: ist("21:00") },
      { id: "morning", due_at: ist("08:00") },
      { id: "afternoon", due_at: ist("13:00") },
      { id: "morning-2", due_at: ist("09:00") },
    ];

    const groups = groupByDayPart(doses);
    expect(groups.map((group) => group.part)).toEqual([
      "Morning",
      "Afternoon",
      "Night",
    ]);
    expect(groups[0].items.map((dose) => dose.id)).toEqual([
      "morning",
      "morning-2",
    ]);
    expect(groups[1].items.map((dose) => dose.id)).toEqual(["afternoon"]);
    expect(groups[2].items.map((dose) => dose.id)).toEqual(["evening"]);
  });
});

describe("snoozeDueAt", () => {
  it("pushes a future dose ten minutes out", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const dueAt = new Date("2026-06-01T00:05:00.000Z").toISOString();
    expect(snoozeDueAt(dueAt, now)).toBe(
      new Date("2026-06-01T00:15:00.000Z").toISOString()
    );
  });

  it("snoozes from now when the dose is already overdue", () => {
    const now = new Date("2026-06-01T00:30:00.000Z");
    const dueAt = new Date("2026-06-01T00:05:00.000Z").toISOString();
    expect(snoozeDueAt(dueAt, now)).toBe(
      new Date("2026-06-01T00:40:00.000Z").toISOString()
    );
  });
});
