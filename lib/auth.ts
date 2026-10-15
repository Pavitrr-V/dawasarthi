import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile, Role } from "@/lib/types";

const PROFILE_COLUMNS = "id, role, name, phone, language";

/**
 * Returns the current user's profile, or null when not signed in.
 * The JWT is verified with getClaims() (never getSession) so a forged
 * cookie cannot authenticate a request.
 */
export const getCurrentUser = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (error || !id) return null;

  const { data: profile } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (profile) return profile as Profile;

  // Fallback: create a minimal profile if the signup trigger ever missed it.
  const meta = (data?.claims?.user_metadata ?? {}) as Record<string, unknown>;
  const role: Role = meta.role === "caregiver" ? "caregiver" : "patient";
  const name = typeof meta.name === "string" ? meta.name : null;

  const { data: created } = await supabase
    .from("users")
    .insert({ id, role, name })
    .select(PROFILE_COLUMNS)
    .single();

  return (created as Profile | null) ?? null;
});

export async function requireUser(): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(role: Role): Promise<Profile> {
  const user = await requireUser();
  if (user.role !== role) {
    redirect(user.role === "caregiver" ? "/caregiver" : "/home");
  }
  return user;
}
