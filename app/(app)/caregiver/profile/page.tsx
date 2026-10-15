import { requireRole } from "@/lib/auth";
import { ProfileView } from "@/components/profile-view";

export default async function CaregiverProfilePage() {
  const user = await requireRole("caregiver");
  return <ProfileView profile={user} />;
}
