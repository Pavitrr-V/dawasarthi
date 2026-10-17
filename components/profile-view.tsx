import { Button, Card, PageHeader } from "@/components/ui";
import { NotificationSettings } from "@/components/push/notification-settings";
import type { Profile } from "@/lib/types";

const ROLE_LABELS: Record<Profile["role"], string> = {
  patient: "Patient",
  caregiver: "Caregiver",
};

export function ProfileView({ profile }: { profile: Profile }) {
  return (
    <div className="space-y-4">
      <PageHeader title="Profile" subtitle="Your account details" />

      <Card className="space-y-3">
        <Row label="Name" value={profile.name ?? "Not set"} />
        <Row label="Role" value={ROLE_LABELS[profile.role]} />
        <Row label="Phone" value={profile.phone ?? "Not set"} />
        <Row label="Language" value={profile.language.toUpperCase()} />
      </Card>

      <NotificationSettings />

      <form action="/auth/signout" method="post">
        <Button type="submit" variant="secondary" className="w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-semibold text-slate-800">{value}</span>
    </div>
  );
}
