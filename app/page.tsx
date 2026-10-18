import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const instant = false;

export default async function RootPage() {
  await connection(); // request-time render: iske baad Date.now() allowed

  const user = await getCurrentUser();

  if (!user) redirect("/login");
  redirect(user.role === "caregiver" ? "/caregiver" : "/home");
}