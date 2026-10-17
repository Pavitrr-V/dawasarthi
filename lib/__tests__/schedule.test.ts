import { describe, expect, it } from "vitest";
import {
  DEFAULT_HORIZON_DAYS,
  MAX_HORIZON_DAYS,
  addDays,
  addMinutes,
  courseLabel,
  diffDays,
  generateDoses,
  istInstant,
  istToday,
  normalizeTimes,
  parseIsoDate,
  patternLabel,
  resolveMealTime,
  weekdayOf,
  type ScheduleForDoses,
} from "@/lib/schedule";

// 2026-06-01 is a Monday.
const MON = "2026-06-01";

function schedule(overrides: Partial<ScheduleForDoses> = {}): ScheduleForDoses {
  return {
    id: "sched-1",
    patient_id: "patient-1",
    times: ["08:00"],
    days_pattern: "daily",
    weekdays: [],
    start_date: MON,
    duration_days: null,
    ...overrides,
  };
}

// A `now` that is still 2026-06-01 in IST (05:30 IST).
const NOW = new Date("2026-06-01T00:00:00.000Z");

describe("time-of-day helpers", () => {
  it("addMinutes wraps around midnight in both directions", () => {
    expect(addMinutes("08:00", 30)).toBe("08:30");
    expect(addMinutes("08:00", -30)).toBe("07:30");
    expect(addMinutes("23:45", 30)).toBe("00:15");
    expect(addMinutes("00:15", -30)).toBe("23:45");
  });

  it("normalizeTimes sorts, dedupes and normalises", () => {
    expect(normalizeTimes(["21:00", "08:00", "8:00", "08:00", "9:05"])).toEqual([
      "08:00",
      "09:05",
      "21:00",
    ]);
  });

  it("resolveMealTime shifts the patient's meal time by 30 minutes", () => {
    expect(resolveMealTime("after_breakfast", { breakfast: "08:00" })).toBe("08:30");
    expect(resolveMealTime("before_lunch", { lunch: "14:00" })).toBe("13:30");
    expect(resolveMealTime("after_dinner", { dinner: "23:45" })).toBe("00:15");
  });

  it("resolveMealTime falls back to default meal times", () => {
    expect(resolveMealTime("after_breakfast", {})).toBe("08:30");
    expect(resolveMealTime("before_dinner", { dinner: null })).toBe("20:30");
  });
});

describe("calendar helpers", () => {
  it("parses strict ISO dates and rejects impossible ones", () => {
    expect(parseIsoDate(MON)).toEqual({ y: 2026, m: 6, d: 1 });
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("01-06-2026")).toBeNull();
    expect(parseIsoDate("2026-6-1")).toBeNull();
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays(MON, -1)).toBe("2026-05-31");
    expect(addDays(MON, 30)).toBe("2026-07-01");
  });

  it("computes weekday and day differences", () => {
    expect(weekdayOf(MON)).toBe(1);
    expect(weekdayOf("2026-06-07")).toBe(0);
    expect(diffDays("2026-06-03", MON)).toBe(2);
    expect(diffDays(MON, "2026-06-03")).toBe(-2);
  });

  it("istToday shifts the instant into Asia/Kolkata (+05:30)", () => {
    expect(istToday(new Date("2026-06-01T18:00:00.000Z"))).toBe("2026-06-01");
    // 19:00 UTC is already the next day in IST.
    expect(istToday(new Date("2026-06-01T19:00:00.000Z"))).toBe("2026-06-02");
  });

  it("istInstant anchors the wall time to +05:30", () => {
    expect(istInstant(MON, "08:00")).toBe("2026-06-01T02:30:00.000Z");
    expect(istInstant(MON, "21:00")).toBe("2026-06-01T15:30:00.000Z");
  });
});

describe("generateDoses", () => {
  it("generates one pending dose per day for a daily schedule", () => {
    const doses = generateDoses(schedule(), 3, NOW);
    expect(doses).toEqual([
      { schedule_id: "sched-1", patient_id: "patient-1", due_at: "2026-06-01T02:30:00.000Z", status: "pending" },
      { schedule_id: "sched-1", patient_id: "patient-1", due_at: "2026-06-02T02:30:00.000Z", status: "pending" },
      { schedule_id: "sched-1", patient_id: "patient-1", due_at: "2026-06-03T02:30:00.000Z", status: "pending" },
    ]);
  });

  it("starts from a future start_date", () => {
    const doses = generateDoses(schedule({ start_date: "2026-06-10" }), 2, NOW);
    expect(doses.map((d) => d.due_at)).toEqual([
      "2026-06-10T02:30:00.000Z",
      "2026-06-11T02:30:00.000Z",
    ]);
  });

  it("top-ups from today when the course began in the past", () => {
    const doses = generateDoses(
      schedule({ start_date: "2026-05-01" }),
      DEFAULT_HORIZON_DAYS,
      NOW
    );
    expect(doses).toHaveLength(7);
    expect(doses[0].due_at).toBe("2026-06-01T02:30:00.000Z");
    expect(doses.every((d) => d.due_at >= "2026-06-01")).toBe(true);
  });

  it("honours the alternate-day pattern", () => {
    const doses = generateDoses(
      schedule({ days_pattern: "alternate" }),
      7,
      NOW
    );
    expect(doses.map((d) => d.due_at.slice(0, 10))).toEqual([
      "2026-06-01",
      "2026-06-03",
      "2026-06-05",
      "2026-06-07",
    ]);
  });

  it("honours the weekdays pattern", () => {
    const doses = generateDoses(
      schedule({ days_pattern: "weekdays", weekdays: [1, 3, 5] }),
      7,
      NOW
    );
    expect(doses.map((d) => d.due_at.slice(0, 10))).toEqual([
      "2026-06-01",
      "2026-06-03",
      "2026-06-05",
    ]);
  });

  it("creates no doses for as-needed schedules", () => {
    expect(generateDoses(schedule({ days_pattern: "as_needed" }), 7, NOW)).toEqual(
      []
    );
  });

  it("stops at the end of a fixed course", () => {
    const doses = generateDoses(schedule({ duration_days: 3 }), 7, NOW);
    expect(doses).toHaveLength(3);
    expect(doses.at(-1)?.due_at.slice(0, 10)).toBe("2026-06-03");
  });

  it("caps the horizon", () => {
    const doses = generateDoses(schedule(), 100, NOW);
    expect(doses).toHaveLength(MAX_HORIZON_DAYS);
  });

  it("produces one dose per time, sorted ascending", () => {
    const doses = generateDoses(
      schedule({ times: ["21:00", "09:00"], start_date: "2026-06-10" }),
      1,
      NOW
    );
    expect(doses.map((d) => d.due_at)).toEqual([
      "2026-06-10T03:30:00.000Z",
      "2026-06-10T15:30:00.000Z",
    ]);
  });

  it("is stable: duplicate or unreadable times collapse", () => {
    const doses = generateDoses(
      schedule({ times: ["08:00", "8:00", "bogus"] }),
      1,
      NOW
    );
    expect(doses).toHaveLength(1);
  });

  it("returns nothing without any usable time", () => {
    expect(generateDoses(schedule({ times: [] }), 7, NOW)).toEqual([]);
  });
});

describe("courseLabel", () => {
  const now = new Date("2026-06-03T00:00:00.000Z"); // 2026-06-03 in IST

  it("shows 'Day X of Y' during a course", () => {
    expect(
      courseLabel({ days_pattern: "daily", start_date: MON, duration_days: 5 }, now)
    ).toBe("Day 3 of 5");
  });

  it("shows just the day number for ongoing schedules", () => {
    expect(
      courseLabel({ days_pattern: "daily", start_date: MON, duration_days: null }, now)
    ).toBe("Day 3");
  });

  it("reports a finished course", () => {
    expect(
      courseLabel({ days_pattern: "daily", start_date: MON, duration_days: 2 }, now)
    ).toBe("Course complete");
  });

  it("is null before the start date and for as-needed", () => {
    expect(
      courseLabel({ days_pattern: "daily", start_date: "2026-06-10", duration_days: null }, now)
    ).toBeNull();
    expect(
      courseLabel({ days_pattern: "as_needed", start_date: MON, duration_days: null }, now)
    ).toBeNull();
  });
});

describe("patternLabel", () => {
  it("describes each pattern", () => {
    expect(patternLabel({ days_pattern: "daily" })).toBe("Every day");
    expect(patternLabel({ days_pattern: "alternate" })).toBe("Every other day");
    expect(patternLabel({ days_pattern: "weekdays", weekdays: [1, 3, 5] })).toBe(
      "Mon, Wed, Fri"
    );
    expect(patternLabel({ days_pattern: "weekdays", weekdays: [] })).toBe(
      "No days chosen"
    );
    expect(patternLabel({ days_pattern: "as_needed" })).toBe("Only when needed");
  });
});
