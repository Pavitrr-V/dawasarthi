/**
 * Reminder scheduling — pure helpers.
 *
 * Everything here is deterministic and free of server-only imports so it can
 * run in a server action, a client component, and the unit tests unchanged.
 *
 * Time zone: all wall-clock times are interpreted in Asia/Kolkata (IST). India
 * has used a fixed UTC+05:30 offset with no daylight saving since 1945, so we
 * anchor instants to an explicit `+05:30` offset instead of relying on the
 * host's timezone (Vercel runs in UTC). `due_at` is always written as a
 * `timestamptz`-compatible ISO string.
 */

export const DAYS_PATTERNS = [
  "daily",
  "alternate",
  "weekdays",
  "as_needed",
] as const;
export type DaysPattern = (typeof DAYS_PATTERNS)[number];

export const MEAL_LINKS = [
  "before_breakfast",
  "after_breakfast",
  "before_lunch",
  "after_lunch",
  "before_dinner",
  "after_dinner",
] as const;
export type MealLink = (typeof MEAL_LINKS)[number];

/** 0 = Sunday … 6 = Saturday (matches JS Date.getUTCDay / the DB check). */
export const WEEKDAY_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export const MAX_TIMES = 6;
export const MAX_DURATION_DAYS = 365;
export const MAX_HORIZON_DAYS = 31;
export const DEFAULT_HORIZON_DAYS = 7;

/** Shift applied to a meal time for a "before"/"after" link. */
export const MEAL_MINUTES_OFFSET = 30;

/** Fallbacks when a patient has not set meal times (matches the app defaults). */
export const DEFAULT_MEAL_TIMES = {
  breakfast: "08:00",
  lunch: "14:00",
  dinner: "21:00",
} as const;

export type MealTimes = {
  breakfast?: string | null;
  lunch?: string | null;
  dinner?: string | null;
};

/** The columns `generateDoses` needs from a `schedules` row. */
export type ScheduleForDoses = {
  id: string;
  patient_id: string;
  times: string[];
  days_pattern: DaysPattern;
  weekdays?: number[] | null;
  start_date: string;
  duration_days?: number | null;
};

export type GeneratedDose = {
  schedule_id: string;
  patient_id: string;
  due_at: string;
  status: "pending";
};

const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1_440;
/** Asia/Kolkata is UTC+05:30 all year. */
const IST_OFFSET_MINUTES = 330;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Time-of-day helpers
// ---------------------------------------------------------------------------

/** Normalises "8:5", "08:05", "08:05:00" to "08:05"; null when unreadable. */
export function normalizeHHMM(value: string | null | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec((value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/** Validates a "HH:MM" string (00:00–23:59). */
export function isHHMM(value: string): boolean {
  return normalizeHHMM(value) !== null;
}

/** Adds (or subtracts) minutes, wrapping around midnight. */
export function addMinutes(hhmm: string, deltaMinutes: number): string {
  const normalized = normalizeHHMM(hhmm) ?? "00:00";
  const [hours, minutes] = normalized.split(":").map(Number);
  const total =
    (((hours * 60 + minutes + deltaMinutes) % MINUTES_PER_DAY) +
      MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Unique, sorted, normalised clock times. */
export function normalizeTimes(times: string[]): string[] {
  const seen = new Set<string>();
  for (const time of times) {
    const normalized = normalizeHHMM(time);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort();
}

/** Unique, sorted weekdays within 0–6. */
export function normalizeWeekdays(days: number[]): number[] {
  const seen = new Set<number>();
  for (const day of days) {
    if (Number.isInteger(day) && day >= 0 && day <= 6) seen.add(day);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Resolves a meal link to a clock time using the patient's meal times. */
export function resolveMealTime(mealLink: MealLink, mealTimes: MealTimes): string {
  const [when, meal] = mealLink.split("_") as [
    "before" | "after",
    keyof typeof DEFAULT_MEAL_TIMES,
  ];
  const base =
    normalizeHHMM(mealTimes[meal]) ?? DEFAULT_MEAL_TIMES[meal];
  return addMinutes(
    base,
    when === "before" ? -MEAL_MINUTES_OFFSET : MEAL_MINUTES_OFFSET
  );
}

/** "after_breakfast" -> "After breakfast". */
export function mealLinkLabel(mealLink: MealLink): string {
  const [when, meal] = mealLink.split("_") as ["before" | "after", string];
  return `${when === "before" ? "Before" : "After"} ${meal}`;
}

// ---------------------------------------------------------------------------
// Calendar-date helpers (timezone-independent, pure integer math)
// ---------------------------------------------------------------------------

type DateParts = { y: number; m: number; d: number };

function isoDateOf(parts: DateParts): string {
  return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

/** Parses a strict "YYYY-MM-DD" calendar date, rejecting impossible dates. */
export function parseIsoDate(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parts: DateParts = {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
  };
  const probe = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (
    probe.getUTCFullYear() !== parts.y ||
    probe.getUTCMonth() !== parts.m - 1 ||
    probe.getUTCDate() !== parts.d
  ) {
    return null;
  }
  return parts;
}

/** Adds calendar days to a "YYYY-MM-DD" string. */
export function addDays(date: string, days: number): string {
  const parts = parseIsoDate(date);
  if (!parts) return date;
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return isoDateOf({
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  });
}

/** 0 = Sunday … 6 = Saturday, or null for an invalid date. */
export function weekdayOf(date: string): number | null {
  const parts = parseIsoDate(date);
  if (!parts) return null;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
}

/** Whole calendar days from `b` to `a` (a − b). */
export function diffDays(a: string, b: string): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  if (!pa || !pb) return 0;
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((ta - tb) / MS_PER_DAY);
}

/** Today's calendar date in Asia/Kolkata, regardless of the host timezone. */
export function istToday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return isoDateOf({
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  });
}

/** The UTC instant for a wall-clock IST time on a calendar date. */
export function istInstant(date: string, hhmm: string): string {
  const normalized = normalizeHHMM(hhmm) ?? "00:00";
  return new Date(`${date}T${normalized}:00+05:30`).toISOString();
}

// ---------------------------------------------------------------------------
// Dose generation
// ---------------------------------------------------------------------------

function matchesPattern(date: string, schedule: ScheduleForDoses): boolean {
  switch (schedule.days_pattern) {
    case "daily":
      return true;
    case "alternate": {
      const index = diffDays(date, schedule.start_date);
      return index >= 0 && index % 2 === 0;
    }
    case "weekdays": {
      const weekday = weekdayOf(date);
      return weekday !== null && (schedule.weekdays ?? []).includes(weekday);
    }
    case "as_needed":
    default:
      return false;
  }
}

/**
 * Materialises the pending `dose_logs` rows for the next `horizonDays` days.
 *
 * - Computes every instant in Asia/Kolkata and returns `timestamptz` ISO
 *   strings, so the result is identical no matter where the server runs.
 * - Starts from `start_date`, or from today when the course already began, so
 *   re-running it as a daily top-up job only ever fills *forward*.
 * - `as_needed` schedules produce no doses.
 * - The result contains no duplicate `due_at` values; the DB unique index on
 *   `(schedule_id, due_at)` makes inserting it (again) a no-op.
 */
export function generateDoses(
  schedule: ScheduleForDoses,
  horizonDays: number = DEFAULT_HORIZON_DAYS,
  now: Date = new Date()
): GeneratedDose[] {
  if (schedule.days_pattern === "as_needed") return [];

  const times = normalizeTimes(schedule.times);
  if (times.length === 0) return [];

  const startParts = parseIsoDate(schedule.start_date);
  if (!startParts) return [];

  const horizon = Math.min(
    Math.max(0, Math.trunc(horizonDays) || 0),
    MAX_HORIZON_DAYS
  );
  if (horizon === 0) return [];

  const startDate = isoDateOf(startParts);
  const today = istToday(now);
  // Never generate in the past: when the course began earlier, fill from today.
  const firstDate = diffDays(today, startDate) > 0 ? today : startDate;

  const duration = schedule.duration_days ?? null;
  const doses: GeneratedDose[] = [];

  for (let offset = 0; offset < horizon; offset += 1) {
    const date = addDays(firstDate, offset);
    const dayIndex = diffDays(date, startDate);
    if (duration !== null && dayIndex >= duration) break;
    if (!matchesPattern(date, schedule)) continue;

    for (const time of times) {
      doses.push({
        schedule_id: schedule.id,
        patient_id: schedule.patient_id,
        due_at: istInstant(date, time),
        status: "pending",
      });
    }
  }

  doses.sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0));
  return doses;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export type CourseInfo = {
  days_pattern: DaysPattern;
  start_date: string;
  duration_days?: number | null;
};

/**
 * "Day 3 of 5" while a course runs, "Day 3" for ongoing schedules, or null
 * before it starts / for as-needed schedules.
 */
export function courseLabel(
  schedule: CourseInfo,
  now: Date = new Date()
): string | null {
  if (schedule.days_pattern === "as_needed") return null;
  const start = parseIsoDate(schedule.start_date);
  if (!start) return null;

  const dayIndex = diffDays(istToday(now), isoDateOf(start)) + 1;
  if (dayIndex < 1) return null;

  const duration = schedule.duration_days ?? null;
  if (duration !== null) {
    if (dayIndex > duration) return "Course complete";
    return `Day ${dayIndex} of ${duration}`;
  }
  return `Day ${dayIndex}`;
}

export type PatternInfo = {
  days_pattern: DaysPattern;
  weekdays?: number[] | null;
};

/** Human-readable schedule summary, e.g. "Every other day" or "Mon, Wed, Fri". */
export function patternLabel(schedule: PatternInfo): string {
  switch (schedule.days_pattern) {
    case "daily":
      return "Every day";
    case "alternate":
      return "Every other day";
    case "weekdays": {
      const days = normalizeWeekdays(schedule.weekdays ?? []);
      if (days.length === 0) return "No days chosen";
      if (days.length === 7) return "Every day";
      return days.map((day) => WEEKDAY_NAMES[day]).join(", ");
    }
    case "as_needed":
    default:
      return "Only when needed";
  }
}
