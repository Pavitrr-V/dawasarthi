import { connection } from "next/server";
import { getPatientContext } from "@/lib/patients";
import { HomeClient } from "@/components/home/HomeClient";

export const instant = false;

export default async function HomePage() {
  await connection(); // request-time render

  // Same source of truth as the profile switcher and Cabinet
  const { selected } = await getPatientContext();

  return <HomeClient patientId={selected?.id ?? null} />;
}