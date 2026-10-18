import type { Adherence, DoseStatus } from "@/lib/types";

/**
 * Weekly adherence maths for the caregiver dashboard.
 *
 * Only *resolved* doses count: a dose that was taken, missed, or skipped. A
 * still-`pending` or `snoozed` dose is neither a success nor a failure, so it
 * is ignored — otherwise a patient who has not looked at the app yet would
 * look non-compliant.
 *
 * Pure (no server imports) so it can run in a unit test and in a client bundle.
 */

/** The statuses that count toward the denominator. */
const COUNTED: readonly DoseStatus[] = ["taken", "missed", "skipped"];

export function isCountedStatus(status: DoseStatus): boolean {
  return COUNTED.includes(status);
}

/**
 * `percent` is the rounded taken / (taken + missed + skipped) share. When there
 * is nothing to measure the percent is null ("No data yet"), never 0.
 */
export function computeAdherence(statuses: readonly DoseStatus[]): Adherence {
  let taken = 0;
  let missed = 0;
  let skipped = 0;

  for (const status of statuses) {
    if (status === "taken") taken += 1;
    else if (status === "missed") missed += 1;
    else if (status === "skipped") skipped += 1;
  }

  const total = taken + missed + skipped;
  return {
    taken,
    missed,
    skipped,
    total,
    percent: total === 0 ? null : Math.round((taken / total) * 100),
  };
}

/** "82%" or "No data yet". */
export function adherenceLabel(adherence: Adherence): string {
  return adherence.percent === null ? "No data yet" : `${adherence.percent}%`;
}

/**
 * Colour tone for the adherence badge: green when the patient is largely
 * keeping up, amber when it is slipping, red when most doses are missed.
 * Returns "none" when there is no data.
 */
export function adherenceTone(adherence: Adherence): "green" | "amber" | "red" | "none" {
  if (adherence.percent === null) return "none";
  if (adherence.percent >= 80) return "green";
  if (adherence.percent >= 50) return "amber";
  return "red";
}
