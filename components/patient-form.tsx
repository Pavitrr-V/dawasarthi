"use client";

import { useActionState } from "react";
import { savePatient, type PatientFormState } from "@/app/(app)/patient-actions";
import { Button, Card, Field, Input } from "@/components/ui";
import { TagInput } from "@/components/tag-input";
import type { PatientProfile } from "@/lib/types";

/** Postgres time values look like "HH:MM:SS"; the time input wants "HH:MM". */
function toTimeInput(value: string | null): string {
  return value ? value.slice(0, 5) : "";
}

export function PatientForm({ patient }: { patient?: PatientProfile }) {
  const [state, action, pending] = useActionState<PatientFormState, FormData>(
    savePatient,
    undefined
  );

  return (
    <form action={action} className="space-y-4">
      {patient && <input type="hidden" name="id" value={patient.id} />}

      <Card className="space-y-4">
        <Field label="Name">
          <Input
            name="name"
            defaultValue={patient?.name ?? ""}
            placeholder="e.g. Anjali Sharma"
            autoComplete="off"
            required
          />
        </Field>

        <Field label="Age" hint="Optional">
          <Input
            name="age"
            type="number"
            inputMode="numeric"
            min={0}
            max={150}
            defaultValue={patient?.age ?? ""}
            placeholder="e.g. 64"
          />
        </Field>
      </Card>

      <Card className="space-y-4">
        <TagInput
          name="allergies"
          label="Allergies"
          hint="Press Enter or Add after each one."
          placeholder="e.g. Penicillin"
          defaultValues={patient?.allergies ?? []}
        />
        <TagInput
          name="conditions"
          label="Conditions"
          hint="Press Enter or Add after each one."
          placeholder="e.g. Diabetes"
          defaultValues={patient?.conditions ?? []}
        />
      </Card>

      <Card className="space-y-4">
        <p className="text-[15px] font-medium text-slate-700">Meal times</p>
        <div className="grid grid-cols-1 gap-3">
          <Field label="Breakfast">
            <Input
              name="breakfast_time"
              type="time"
              defaultValue={toTimeInput(patient?.breakfast_time ?? null)}
            />
          </Field>
          <Field label="Lunch">
            <Input
              name="lunch_time"
              type="time"
              defaultValue={toTimeInput(patient?.lunch_time ?? null)}
            />
          </Field>
          <Field label="Dinner">
            <Input
              name="dinner_time"
              type="time"
              defaultValue={toTimeInput(patient?.dinner_time ?? null)}
            />
          </Field>
        </div>
      </Card>

      {state?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
          {state.error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving..." : patient ? "Save changes" : "Create profile"}
      </Button>
    </form>
  );
}
