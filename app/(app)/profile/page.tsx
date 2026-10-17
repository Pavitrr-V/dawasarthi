import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { listPatientProfiles } from "@/lib/patients";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { DeleteDataButton } from "@/components/delete-data-button";
import { NotificationSettings } from "@/components/push/notification-settings";

export const instant = false;

export default async function PatientProfilePage() {
  const user = await requireRole("patient");
  const profiles = await listPatientProfiles();

  return (
    <div className="space-y-4">
      <PageHeader title="Profile" subtitle="Your account and patient profiles." />

      <Card className="space-y-3">
        <Row label="Name" value={user.name ?? "Not set"} />
        <Row label="Account" value="Patient" />
        <Row label="Phone" value={user.phone ?? "Not set"} />
        <Row label="Language" value={user.language.toUpperCase()} />
      </Card>

      <NotificationSettings />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Patient profiles
          </h2>
          <Link
            href="/patients/new"
            className="text-[15px] font-semibold text-primary-700"
          >
            + Add
          </Link>
        </div>

        {profiles.length === 0 ? (
          <EmptyState
            title="No profiles yet"
            description="Add a patient profile to start scanning medicines."
            action={
              <Link href="/patients/new" className="mt-2 block">
                <Button>Add a profile</Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">
            {profiles.map((patient) => (
              <Link
                key={patient.id}
                href={`/patients/${patient.id}/edit`}
                className="block"
              >
                <Card className="flex items-center justify-between transition-colors hover:border-primary-300 hover:bg-primary-50/40">
                  <span>
                    <span className="block text-[17px] font-semibold text-slate-900">
                      {patient.name}
                    </span>
                    <span className="block text-[15px] text-slate-500">
                      {patient.age !== null ? `${patient.age} years` : "Age not set"}
                    </span>
                  </span>
                  <span className="text-[15px] font-semibold text-primary-700">
                    Edit
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2 pt-2">
        <DeleteDataButton />
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="secondary" className="w-full">
            Sign out
          </Button>
        </form>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[15px] text-slate-500">{label}</span>
      <span className="text-[15px] font-medium text-slate-900">{value}</span>
    </div>
  );
}
