import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { listCaregiverLinkSummaries } from "@/lib/caregiver-dashboard";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { PatientsIcon } from "@/components/icons";

export const instant = false;

export default async function CaregiverPatientsPage() {
  await requireRole("caregiver");
  const links = await listCaregiverLinkSummaries();

  const active = links.filter(
    (link) => link.status === "active" && link.consent_given
  );
  const pending = links.filter(
    (link) => link.status === "pending" && !link.consent_given
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Patients"
        subtitle="Link to a patient using the invite code they share with you."
      />

      <Link href="/join">
        <Button className="w-full">Enter an invite code</Button>
      </Link>

      {pending.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-[15px] font-semibold text-slate-700">
            Waiting for approval
          </h2>
          {pending.map((link) => (
            <Card key={link.id} className="flex items-center gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                <PatientsIcon />
              </span>
              <div className="flex-1">
                <p className="text-[17px] font-semibold text-slate-900">
                  {link.patient_name ?? "Patient awaiting approval"}
                </p>
                <p className="text-[15px] text-slate-500">
                  They need to approve your request.
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {active.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-[15px] font-semibold text-slate-700">
            Linked patients
          </h2>
          {active.map((link) => (
            <Link
              key={link.id}
              href={`/caregiver/patients/${link.patient_id}`}
              className="block min-h-[48px] rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
            >
              <Card className="flex items-center gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-100 text-primary-700">
                  <PatientsIcon />
                </span>
                <div className="flex-1">
                  <p className="text-[17px] font-semibold text-slate-900">
                    {link.patient_name ?? "Patient"}
                  </p>
                  <p className="text-[15px] text-emerald-600">
                    Consent given — view medicines & history
                  </p>
                </div>
                <span className="pr-2 text-[15px] font-semibold text-primary-700">
                  →
                </span>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        pending.length === 0 && (
          <EmptyState
            title="No linked patients"
            description="Once a patient approves your request, they will show up here with their medicines and dose alerts."
          />
        )
      )}
    </div>
  );
}
