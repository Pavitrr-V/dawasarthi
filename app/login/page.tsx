import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { Disclaimer } from "@/components/disclaimer";
import { LoginForm } from "./login-form";

export const instant = false;

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex flex-1 flex-col justify-center px-5 py-10">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-600 text-2xl font-bold text-white shadow-sm">
            M
          </div>
          <h1 className="text-3xl font-bold text-slate-900">MedScan</h1>
          <p className="mt-1 text-slate-500">
            Scan a medicine, check its trust, and never miss a dose.
          </p>
        </div>
        <LoginForm />
      </main>
      <Disclaimer className="border-t border-slate-200" />
    </div>
  );
}
