import { connection } from "next/server";
import { requireRole } from "@/lib/auth";
import { ProfileView } from "@/components/profile-view";

export default async function CaregiverProfilePage() {
  await connection();
  const user = await requireRole("caregiver");
  return <ProfileView profile={user} />;
}
