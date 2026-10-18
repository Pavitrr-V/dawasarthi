"use client";

import { useActionState } from "react";
import Link from "next/link";
import { claimCaregiverInvite, type ClaimState } from "./actions";
import { Button, Card, PageHeader } from "@/components/ui";

/**
 * The caregiver-facing consent screen. Shown only once the caregiver is
 * signed in with a valid, unclaimed invite. Nothing is written until they
 * tap "Send request".
 */
export function JoinConsent({
  code,
  patientFirstName,
}: {
  code: string;
  patientFirstName: string;
}) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(
    claimCaregiverInvite,
    undefined
  );

  if (state && "ok" in state) {
    return (
      <>
        <PageHeader
          title="Request sent"
          subtitle={`${state.patientFirstName} now needs to approve your request.`}
        />
        <Card className="space-y-3">
          <p className="text-[15px] text-slate-600">
            For your safety and theirs, you will see nothing until{" "}
            {state.patientFirstName} approves. You can check back on your
            dashboard.
          </p>
          <Link href="/caregiver/patients">
            <Button className="w-full">View my patients</Button>
          </Link>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Caregiver consent"
        subtitle={`You've been invited to care for ${patientFirstName}.`}
      />

      <Card className="space-y-3">
        <p className="text-[15px] font-medium text-slate-800">
          If {patientFirstName} approves, you will be able to see:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-[15px] text-slate-600">
          <li>Their scanned medicines and risk flags</li>
          <li>Today&apos;s doses and reminder history</li>
          <li>Alerts when a dose is missed</li>
        </ul>
        <p className="text-[15px] text-slate-600">
          {patientFirstName} must approve before you see anything, and they can
          revoke your access at any time.
        </p>
      </Card>

      <form action={action} className="mt-4 space-y-3">
        <input type="hidden" name="code" value={code} />

        {state && "error" in state && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
            {state.error}
          </div>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Sending request..." : "I understand — send request"}
        </Button>
        <Link href="/" className="block">
          <Button type="button" variant="secondary" className="w-full">
            Cancel
          </Button>
        </Link>
      </form>
    </>
  );
}
