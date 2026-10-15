"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().trim().min(1, { error: "Please enter a name." }).max(80),
  age: z.coerce.number().int().min(0).max(150).optional(),
});

export type OnboardingState = { error?: string } | undefined;

export async function completeOnboarding(
  _state: OnboardingState,
  formData: FormData
): Promise<OnboardingState> {
  const user = await requireUser();

  const rawAge = formData.get("age");
  const parsed = schema.safeParse({
    name: formData.get("name"),
    age:
      typeof rawAge === "string" && rawAge.trim() !== ""
        ? rawAge
        : undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const supabase = await createClient();

  const { error: profileError } = await supabase
    .from("users")
    .update({ name: parsed.data.name })
    .eq("id", user.id);

  if (profileError) {
    return { error: "Could not save your profile. Please try again." };
  }

  if (user.role === "patient") {
    const { count } = await supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", user.id);

    if (!count) {
      const { error: patientError } = await supabase.from("patients").insert({
        owner_user_id: user.id,
        name: parsed.data.name,
        age: parsed.data.age ?? null,
      });

      if (patientError) {
        return { error: "Could not create your patient profile." };
      }
    }
  }

  redirect(user.role === "caregiver" ? "/caregiver" : "/home");
}
