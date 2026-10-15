import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getSelectedPatient } from "@/lib/patients";
import { Card, PageHeader } from "@/components/ui";
import { CabinetIcon, HistoryIcon, ScanIcon } from "@/components/icons";

export default async function HomePage() {
  await requireRole("patient");
  const selected = await getSelectedPatient();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Home"
        subtitle={
          selected
            ? `Medicines, trust checks, and reminders for ${selected.name}.`
            : "Your medicines, trust checks, and reminders in one place."
        }
      />

      <div className="grid grid-cols-1 gap-3">
        <QuickAction
          href="/scan"
          title="Scan a medicine"
          description="Photo of a strip, box, or prescription"
          Icon={ScanIcon}
        />
        <QuickAction
          href="/cabinet"
          title="My cabinet"
          description="View your medicines and stock"
          Icon={CabinetIcon}
        />
        <QuickAction
          href="/history"
          title="Dose history"
          description="See taken, skipped, and missed doses"
          Icon={HistoryIcon}
        />
      </div>

      <Card className="bg-primary-50 text-[15px] text-primary-900">
        Tip: Add your caregiver from Profile so they can be alerted if a dose is
        missed.
      </Card>
    </div>
  );
}

function QuickAction({
  href,
  title,
  description,
  Icon,
}: {
  href: string;
  title: string;
  description: string;
  Icon: (props: { className?: string }) => React.ReactNode;
}) {
  return (
    <Link href={href} className="block">
      <Card className="flex items-center gap-4 transition-colors hover:border-primary-300 hover:bg-primary-50/40">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-primary-700">
          <Icon />
        </span>
        <span className="flex-1">
          <span className="block text-lg font-semibold text-slate-900">
            {title}
          </span>
          <span className="block text-[15px] text-slate-500">{description}</span>
        </span>
      </Card>
    </Link>
  );
}
