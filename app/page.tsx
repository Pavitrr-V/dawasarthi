import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export const instant = false;

export default async function RootPage() {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  redirect(user.role === "caregiver" ? "/caregiver" : "/home");
}
