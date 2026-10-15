import { requireUser } from "@/lib/auth";
import { Disclaimer } from "@/components/disclaimer";
import { OnboardingForm } from "./onboarding-form";

export const instant = false;

export default async function OnboardingPage() {
  const user = await requireUser();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 px-5 py-10">
        <h1 className="text-2xl font-bold text-slate-900">
          {user.role === "caregiver"
            ? "Set up your caregiver account"
            : "Set up your profile"}
        </h1>
        <p className="mt-1 mb-6 text-slate-500">
          {user.role === "caregiver"
            ? "You will link to patients using their invite code."
            : "This helps us tailor reminders and safety checks."}
        </p>
        <OnboardingForm role={user.role} defaultName={user.name ?? ""} />
      </main>
      <Disclaimer className="border-t border-slate-200" />
    </div>
  );
}
