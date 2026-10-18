"use client";

import { useSyncExternalStore, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { DISCLAIMER } from "@/lib/constants";
import {
  PATTERN_OPTIONS,
  TIMING_OPTIONS,
  computeSummary,
  emptyRow,
  formatClock12,
  getPrescriptionReviewPayload,
  getPrescriptionReviewServerSnapshot,
  initialRowsFromExtraction,
  needsVerify,
  patternDosesPerDay,
  rowsAreSavable,
  type PrescriptionReviewPayload,
  type ReviewRow,
} from "@/lib/prescription-review";
import type { MealTimes } from "@/lib/schedule";
import type { PrescriptionExtraction } from "@/lib/prescription";
import {
  savePrescription,
  type SavePrescriptionResult,
} from "./actions";

function subscribe(): () => void {
  return () => {};
}

const selectSkin =
  "min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-[17px] text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200";
const inputSkin =
  "min-h-[48px] w-full rounded-xl border border-slate-300 bg-white px-3 text-[17px] text-slate-900 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[15px] font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

/**
 * Reads the prescription handed over by /scan (sessionStorage, so it is
 * per-tab) and renders one editable card per medicine line. Nothing is saved
 * until "Confirm and create schedule" is pressed.
 */
export function PrescriptionReviewView({
  patientId,
  patientName,
  mealTimes,
}: {
  patientId: string;
  patientName: string;
  mealTimes: MealTimes;
}) {
  const payload: PrescriptionReviewPayload | null | undefined = useSyncExternalStore(
    subscribe,
    getPrescriptionReviewPayload,
    getPrescriptionReviewServerSnapshot
  );

  if (payload === undefined) {
    return (
      <Card className="space-y-3">
        <p className="text-[15px] text-slate-500">Loading your prescription…</p>
        <div className="animate-pulse space-y-2">
          <div className="h-4 w-2/3 rounded bg-slate-200" />
          <div className="h-4 w-1/2 rounded bg-slate-200" />
        </div>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card className="space-y-3">
        <p className="text-[17px] font-semibold text-slate-800">Nothing to review</p>
        <p className="text-[15px] text-slate-600">
          We could not find a scanned prescription in this tab. Scan it again, or add
          the medicines manually.
        </p>
        <Link href="/scan" className="block">
          <Button className="w-full">Scan again</Button>
        </Link>
      </Card>
    );
  }

  return (
    <PrescriptionRowsForm
      extraction={payload.extraction}
      imagePaths={payload.imagePaths}
      patientId={patientId}
      patientName={patientName}
      mealTimes={mealTimes}
    />
  );
}

type Phase = "editing" | "saving" | "done";

function PrescriptionRowsForm({
  extraction,
  imagePaths,
  patientId,
  patientName,
  mealTimes,
}: {
  extraction: PrescriptionExtraction;
  imagePaths: string[];
  patientId: string;
  patientName: string;
  mealTimes: MealTimes;
}) {
  const [rows, setRows] = useState<ReviewRow[]>(() =>
    initialRowsFromExtraction(extraction)
  );
  const [phase, setPhase] = useState<Phase>("editing");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SavePrescriptionResult | null>(null);

  const summary = computeSummary(rows, mealTimes);
  const savable = rowsAreSavable(rows);

  function updateRow(id: string, patch: Partial<ReviewRow>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  async function handleConfirm() {
    if (!savable || phase !== "editing") return;
    setPhase("saving");
    setError(null);

    const input = {
      patientId,
      imagePaths,
      rows: rows.map((row) => ({
        name: row.name.trim(),
        strength: row.strength.trim(),
        form: row.form.trim(),
        pattern: row.pattern,
        timing: row.timing || "any",
        duration_days: row.duration_days.trim() === "" ? "7" : row.duration_days.trim(),
        instructions: row.instructions.trim(),
        tablet_count: row.tablet_count.trim(),
        raw_text: row.raw_text,
        confidence: row.confidence,
        verified: row.verified,
      })),
    };

    try {
      const res = await savePrescription(input);
      if (!res.ok) {
        setError(res.error);
        setPhase("editing");
        return;
      }
      setResult(res);
      setPhase("done");
      try {
        const { clearPrescriptionReviewPayload } = await import(
          "@/lib/prescription-review"
        );
        clearPrescriptionReviewPayload();
      } catch {
        // Nothing to clean up.
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPhase("editing");
    }
  }

  if (phase === "done" && result && result.ok) {
    return (
      <div className="space-y-4">
        <Card className="space-y-3">
          <p className="text-[19px] font-bold text-slate-900">
            Saved {result.medicineIds.length} medicine
            {result.medicineIds.length === 1 ? "" : "s"} for {patientName}
          </p>
          <p className="text-[15px] text-slate-600">
            {summary.remindersPerDay} reminder{summary.remindersPerDay === 1 ? "" : "s"}/day
            {summary.firstReminder
              ? `, first at ${summary.firstReminder.label}`
              : ""}
            . We will nudge you and track each dose.
          </p>

          {result.catalogUnmatched.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[15px] font-semibold text-amber-800">
                Not found in the medicine catalogue (amber trust flag):
              </p>
              <ul className="mt-1 list-inside list-disc text-[15px] text-amber-800">
                {result.catalogUnmatched.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}

          <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[15px] text-slate-600">
            Checking online alerts{result.verifyStarted > 0 ? ` for ${result.verifyStarted} medicine${result.verifyStarted === 1 ? "" : "s"}` : ""}… this runs in the background and updates the trust card shortly.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Link href="/home" className="block">
              <Button className="w-full">Go to home</Button>
            </Link>
            <Link href="/cabinet" className="block">
              <Button variant="secondary" className="w-full">
                Open cabinet
              </Button>
            </Link>
          </div>
        </Card>
        <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-1">
        <p className="text-[17px] font-semibold text-slate-900">
          {summary.total} medicine{summary.total === 1 ? "" : "s"} ·{" "}
          {summary.remindersPerDay} reminder
          {summary.remindersPerDay === 1 ? "" : "s"}/day
        </p>
        <p className="text-[15px] text-slate-600">
          {summary.firstReminder
            ? `First reminder tomorrow ${formatClock12(summary.firstReminder.hhmm)}.`
            : "Add a dose pattern to see when the first reminder fires."}
        </p>
      </Card>

      {rows.map((row) => (
        <RowCard
          key={row.id}
          row={row}
          onChange={(patch) => updateRow(row.id, patch)}
          onRemove={() => removeRow(row.id)}
        />
      ))}

      <button
        type="button"
        onClick={addRow}
        className="min-h-[48px] w-full rounded-xl border border-dashed border-slate-300 text-[17px] font-semibold text-slate-600 hover:bg-slate-50"
      >
        + Add medicine
      </button>

      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[15px] text-red-700">
          {error}
        </p>
      )}

      {!savable && (
        <p className="text-[15px] text-amber-700">
          Give every medicine a name and pattern, and tick “I verified this” on any
          amber row, to continue.
        </p>
      )}

      <Button
        type="button"
        className="w-full"
        onClick={handleConfirm}
        disabled={!savable || phase === "saving"}
      >
        {phase === "saving" ? "Saving…" : "Confirm and create schedule"}
      </Button>

      <p className="text-center text-sm text-slate-400">{DISCLAIMER}</p>
    </div>
  );
}

function RowCard({
  row,
  onChange,
  onRemove,
}: {
  row: ReviewRow;
  onChange: (patch: Partial<ReviewRow>) => void;
  onRemove: () => void;
}) {
  const lowConfidence = needsVerify(row);
  const perDay = patternDosesPerDay(row.pattern);

  return (
    <Card
      className={
        lowConfidence
          ? "space-y-3 border-2 border-amber-300 bg-amber-50/60"
          : "space-y-3"
      }
    >
      {lowConfidence && (
        <div className="rounded-xl border border-amber-200 bg-amber-100/70 px-3 py-2">
          <p className="text-[15px] font-semibold text-amber-800">
            Please check this line — we were not fully sure.
          </p>
          {row.raw_text && (
            <p className="mt-1 font-mono text-[14px] text-amber-900">“{row.raw_text}”</p>
          )}
          <label className="mt-2 flex min-h-[48px] items-center gap-3">
            <input
              type="checkbox"
              checked={row.verified}
              onChange={(e) => onChange({ verified: e.target.checked })}
              className="h-6 w-6 rounded border-amber-400 text-primary-600 focus:ring-primary-400"
            />
            <span className="text-[15px] font-semibold text-amber-900">
              I verified this line
            </span>
          </label>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] text-slate-500">
          Confidence {Math.round(row.confidence * 100)}%
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="min-h-[44px] rounded-lg px-3 text-[15px] font-semibold text-red-600 hover:bg-red-50"
        >
          Delete
        </button>
      </div>

      <Field label="Medicine name">
        <input
          className={inputSkin}
          value={row.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Paracetamol"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Strength">
          <input
            className={inputSkin}
            value={row.strength}
            onChange={(e) => onChange({ strength: e.target.value })}
            placeholder="500mg"
          />
        </Field>
        <Field label="Form">
          <input
            className={inputSkin}
            value={row.form}
            onChange={(e) => onChange({ form: e.target.value })}
            placeholder="tablet"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Pattern">
          <select
            className={selectSkin}
            value={row.pattern}
            onChange={(e) => onChange({ pattern: e.target.value })}
          >
            <option value="">—</option>
            {PATTERN_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timing">
          <select
            className={selectSkin}
            value={row.timing}
            onChange={(e) => onChange({ timing: e.target.value as ReviewRow["timing"] })}
          >
            {TIMING_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Days">
          <input
            className={inputSkin}
            inputMode="numeric"
            value={row.duration_days}
            onChange={(e) => onChange({ duration_days: e.target.value })}
            placeholder="7"
          />
        </Field>
        <Field label="Tablets you have">
          <input
            className={inputSkin}
            inputMode="numeric"
            value={row.tablet_count}
            onChange={(e) => onChange({ tablet_count: e.target.value })}
            placeholder={perDay > 0 ? String(perDay) : "optional"}
          />
        </Field>
      </div>

      <Field label="Instructions (optional)">
        <input
          className={inputSkin}
          value={row.instructions}
          onChange={(e) => onChange({ instructions: e.target.value })}
          placeholder="after food"
        />
      </Field>
    </Card>
  );
}
