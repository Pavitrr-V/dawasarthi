import { requireRole } from "@/lib/auth";
import { ProfileView } from "@/components/profile-view";

export default async function PatientProfilePage() {
  const user = await requireRole("patient");
  return <ProfileView profile={user} />;
}
