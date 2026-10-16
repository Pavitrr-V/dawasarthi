import Link from "next/link";
import { Button, Card, PageHeader } from "@/components/ui";
import { Disclaimer } from "@/components/disclaimer";

export const metadata = {
  title: "Demo alert | MedScan",
  description:
    "A simulated NSQ alert used to demonstrate MedScan's official-alert matching.",
  robots: { index: false, follow: false },
};

/**
 * Public demo page. Official (NSQ) alerts carry a `source_url`; the seeded
 * demo alerts point here so the "Source" link resolves and the trust card can
 * show a "Demo data" label. Kept outside the (app) group and listed in
 * PUBLIC_PATHS so it is reachable without signing in.
 */
export default function DemoAlertPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 space-y-4 px-5 py-10">
        <PageHeader
          title="Demo alert"
          subtitle="Simulated NSQ notice for MedScan demonstrations"
        />

        <Card className="space-y-3 border-amber-200 bg-amber-50">
          <span className="inline-block rounded-full bg-amber-200 px-3 py-1 text-[12px] font-bold tracking-wide text-amber-900 uppercase">
            Demo data
          </span>
          <p className="text-[15px] font-medium text-amber-900">
            This is a simulated alert used for demonstration. Real alerts come
            from CDSCO&apos;s official NSQ list.
          </p>
        </Card>

        <Card className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Sample notice
          </h2>
          <dl className="space-y-2 text-[15px]">
            <Row label="Product" value="DEMO Paracetamol Tablets IP 500mg" />
            <Row label="Batch no." value="DMO-PCM-001" />
            <Row label="Manufacturer" value="Demo Pharma Ltd" />
            <Row label="Result" value="Not of standard quality (simulated)" />
            <Row label="Reporting month" value="August 2026" />
          </dl>
        </Card>

        <p className="text-[15px] text-slate-500">
          Genuine alerts are published by the Central Drugs Standard Control
          Organisation (CDSCO). Always confirm a medicine against the official
          list and with a doctor or pharmacist.
        </p>

        <Link href="/" className="block">
          <Button className="w-full">Back to MedScan</Button>
        </Link>
      </main>
      <Disclaimer className="border-t border-slate-200" />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 font-medium text-slate-500">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value}</dd>
    </div>
  );
}
