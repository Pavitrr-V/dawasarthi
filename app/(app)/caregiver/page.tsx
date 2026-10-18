import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { PatientsIcon } from "@/components/icons";

export default async function CaregiverDashboardPage() {
  const user = await requireRole("caregiver");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome${user.name ? `, ${user.name.split(" ")[0]}` : ""}. Your patients appear here after they approve consent.`}
      />

      <Card className="flex items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-100 text-primary-700">
          <PatientsIcon />
        </span>
        <div className="flex-1">
          <p className="text-lg font-semibold text-slate-900">No patients yet</p>
          <p className="text-[15px] text-slate-500">
            Ask your patient for their invite code.
          </p>
        </div>
      </Card>

      <Link
        href="/join"
        className="block rounded-2xl border border-primary-200 bg-primary-50 px-4 py-4 text-center text-lg font-semibold text-primary-700"
      >
        Enter an invite code
      </Link>

      <Card className="text-[15px] text-slate-600">
        You will only see a patient&apos;s data after they explicitly give
        consent. They can revoke it at any time.
      </Card>
    </div>
  );
}
