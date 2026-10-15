"use client";

import { useActionState } from "react";
import { completeOnboarding, type OnboardingState } from "./actions";
import { Button, Field, Input } from "@/components/ui";
import type { Role } from "@/lib/types";

export function OnboardingForm({
  role,
  defaultName,
}: {
  role: Role;
  defaultName: string;
}) {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(
    completeOnboarding,
    undefined
  );

  return (
    <form action={action} className="space-y-4">
      <Field label={role === "caregiver" ? "Your name" : "Patient name"}>
        <Input
          name="name"
          defaultValue={defaultName}
          placeholder="e.g. Anjali Sharma"
          autoComplete="name"
          required
        />
      </Field>

      {role === "patient" && (
        <Field label="Age" hint="Optional">
          <Input
            name="age"
            type="number"
            inputMode="numeric"
            min={0}
            max={150}
            placeholder="e.g. 64"
          />
        </Field>
      )}

      {state?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
          {state.error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending
          ? "Saving..."
          : role === "caregiver"
            ? "Go to dashboard"
            : "Save and continue"}
      </Button>
    </form>
  );
}
