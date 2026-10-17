import { Card } from "@/components/ui";
import {
  courseLabel,
  mealLinkLabel,
  normalizeTimes,
  patternLabel,
  type DaysPattern,
  type MealLink,
} from "@/lib/schedule";

export type ScheduleCardRow = {
  id: string;
  times: string[] | null;
  days_pattern: DaysPattern;
  weekdays: number[] | null;
  meal_link: string | null;
  start_date: string;
  duration_days: number | null;
};

function asMealLink(value: string | null): MealLink | null {
  return value &&
    [
      "before_breakfast",
      "after_breakfast",
      "before_lunch",
      "after_lunch",
      "before_dinner",
      "after_dinner",
    ].includes(value)
    ? (value as MealLink)
    : null;
}

/**
 * Server-rendered list of a medicine's active reminders, with course progress
 * ("Day 3 of 5") computed from `start_date` in Asia/Kolkata.
 */
export function ScheduleList({ schedules }: { schedules: ScheduleCardRow[] }) {
  if (schedules.length === 0) return null;

  return (
    <Card className="space-y-3">
      <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        Reminders
      </p>
      <ul className="space-y-3">
        {schedules.map((schedule) => {
          const times = normalizeTimes(schedule.times ?? []);
          const meal = asMealLink(schedule.meal_link);
          const course = courseLabel({
            days_pattern: schedule.days_pattern,
            start_date: schedule.start_date,
            duration_days: schedule.duration_days,
          });
          return (
            <li
              key={schedule.id}
              className="rounded-xl border border-slate-200 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[16px] font-semibold text-slate-900">
                  {patternLabel({
                    days_pattern: schedule.days_pattern,
                    weekdays: schedule.weekdays,
                  })}
                </p>
                {course && (
                  <span className="shrink-0 rounded-full bg-primary-50 px-2.5 py-0.5 text-[13px] font-bold text-primary-800">
                    {course}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[15px] text-slate-600">
                {schedule.days_pattern === "as_needed"
                  ? "Take only when needed"
                  : times.length > 0
                    ? `At ${times.join(", ")}`
                    : "No times set"}
                {meal ? ` · ${mealLinkLabel(meal)}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
