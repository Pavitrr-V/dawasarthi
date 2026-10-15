import { requireRole } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { ScanIcon } from "@/components/icons";

export default async function ScanPage() {
  await requireRole("patient");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Scan"
        subtitle="Point your camera at a medicine strip, box, or prescription."
      />

      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-100 text-primary-700">
          <ScanIcon className="h-8 w-8" />
        </span>
        <p className="text-lg font-semibold text-slate-800">
          Camera scanning is coming next
        </p>
        <p className="max-w-xs text-slate-500">
          Uploading and extracting medicine details will be enabled in the next
          build step.
        </p>
      </Card>

      <Card className="text-[15px] text-slate-600">
        Every scan gets a Green, Amber, or Red trust card based on
        rule-based checks, never the model&apos;s opinion.
      </Card>
    </div>
  );
}
