"use client";

import { useActionState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  createCaregiverInvite,
  type InviteState,
} from "@/app/(app)/caregiver-actions";
import { Button, Card, Field, Input } from "@/components/ui";
import { joinUrl } from "@/lib/caregiver";
import { CopyLinkButton } from "./copy-link-button";

/**
 * Patient-side "Invite a caregiver" form. Nothing is written until the
 * patient submits; on success the new code, a QR and a copyable link are
 * shown so they can share it in person, by message, or by voice.
 */
export function InviteForm({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(
    createCaregiverInvite,
    undefined
  );

  // Only needed once a code exists (i.e. after submit on the client), so we
  // can read the browser origin at render time without an effect.
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ||
    (typeof window === "undefined" ? "" : window.location.origin);

  const result = state && "code" in state ? state : null;

  if (result) {
    const qrValue = origin ? joinUrl(result.code, origin) : "";
    return (
      <Card className="space-y-4">
        <div className="text-center">
          <p className="text-[15px] text-slate-500">
            {result.caregiverName
              ? `Share this with ${result.caregiverName}`
              : "Share this invite"}
          </p>
          <p className="mt-1 font-mono text-3xl font-bold tracking-[0.2em] text-slate-900">
            {result.code}
          </p>
        </div>

        {qrValue && (
          <div className="flex justify-center rounded-xl border border-slate-200 bg-white p-4">
            <QRCodeSVG value={qrValue} size={168} level="M" />
          </div>
        )}

        <p className="text-center text-[15px] text-slate-500">
          They can scan the code or enter it at{" "}
          <span className="font-medium text-slate-700">
            {origin || "MedScan"} /join
          </span>
        </p>

        <CopyLinkButton code={result.code} className="w-full" />

        <p className="text-center text-sm text-slate-400">
          This invite works for 48 hours and once. You can revoke it any time.
        </p>
      </Card>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="patient_id" value={patientId} />

      <Card className="space-y-4">
        <Field label="Caregiver's name" hint="Optional — just for your records.">
          <Input
            name="caregiver_name"
            placeholder="e.g. Rahul"
            autoComplete="off"
            maxLength={80}
          />
        </Field>
        <Field
          label="Caregiver's mobile"
          hint="Optional. Needed later for SMS/WhatsApp alerts."
        >
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            placeholder="e.g. 98765 43210"
            autoComplete="off"
          />
        </Field>
      </Card>

      {state && "error" in state && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">
          {state.error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating invite..." : "Create invite code"}
      </Button>
    </form>
  );
}
