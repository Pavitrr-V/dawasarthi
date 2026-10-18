import {
  approveCaregiver,
  cancelCaregiverInvite,
  declineCaregiver,
  revokeCaregiver,
} from "@/app/(app)/caregiver-actions";
import { loadCaregiverLinks } from "@/lib/caregiver-server";
import { Button, Card } from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { InviteForm } from "./invite-form";
import { CopyLinkButton } from "./copy-link-button";

function label(name: string | null, maskedPhone: string | null): string {
  return name || maskedPhone || "Caregiver";
}

/**
 * Patient-side "Family" section: invite a caregiver, approve or decline
 * pending requests, and revoke access. All mutations are server actions in
 * caregiver-actions.ts, which re-check ownership before touching a row.
 */
export async function FamilySection({
  patientId,
  patientFirstName,
}: {
  patientId: string;
  patientFirstName: string;
}) {
  const links = await loadCaregiverLinks(patientId);

  const requests = links.filter(
    (link) => link.status === "pending" && link.caregiver_user_id !== null
  );
  const active = links.filter((link) => link.status === "active");
  const invitations = links.filter(
    (link) => link.status === "pending" && link.caregiver_user_id === null
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Family &amp; caregivers
        </h2>
        <p className="text-[15px] text-slate-500">
          Let someone help {patientFirstName} manage medicines and missed doses.
        </p>
      </div>

      {requests.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[15px] font-semibold text-slate-700">
            Waiting for your approval
          </h3>
          {requests.map((link) => (
            <Card key={link.id} className="space-y-3">
              <div>
                <p className="text-[17px] font-semibold text-slate-900">
                  {label(link.caregiver_name, link.caregiver_phone_masked)}
                </p>
                <p className="text-[15px] text-slate-500">
                  Wants to help care for {patientFirstName}.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <form action={approveCaregiver}>
                  <input type="hidden" name="id" value={link.id} />
                  <Button type="submit" className="w-full">
                    Approve
                  </Button>
                </form>
                <form action={declineCaregiver}>
                  <input type="hidden" name="id" value={link.id} />
                  <ConfirmSubmitButton
                    message="Decline this request? They will lose access."
                    className="w-full"
                  >
                    Decline
                  </ConfirmSubmitButton>
                </form>
              </div>
            </Card>
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[15px] font-semibold text-slate-700">
            Linked caregivers
          </h3>
          {active.map((link) => (
            <Card key={link.id} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[17px] font-semibold text-slate-900">
                  {label(link.caregiver_name, link.caregiver_phone_masked)}
                </p>
                <p className="text-[15px] text-emerald-600">
                  Can see medicines and doses
                </p>
              </div>
              <form action={revokeCaregiver}>
                <input type="hidden" name="id" value={link.id} />
                <ConfirmSubmitButton
                  message="Revoke access? They will no longer see any data."
                  className="border-red-200 text-red-700 hover:bg-red-50"
                >
                  Revoke
                </ConfirmSubmitButton>
              </form>
            </Card>
          ))}
        </div>
      )}

      {invitations.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[15px] font-semibold text-slate-700">
            Invites you have created
          </h3>
          {invitations.map((link) => (
            <Card key={link.id} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xl font-bold tracking-[0.15em] text-slate-900">
                  {link.invite_code}
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-sm font-medium ${
                    link.expired
                      ? "bg-slate-100 text-slate-500"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {link.expired ? "Expired" : "Not used yet"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <CopyLinkButton code={link.invite_code} className="w-full" />
                <form action={cancelCaregiverInvite}>
                  <input type="hidden" name="id" value={link.id} />
                  <ConfirmSubmitButton
                    message="Cancel this invite code?"
                    className="w-full"
                  >
                    Cancel
                  </ConfirmSubmitButton>
                </form>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3 pt-1">
        <h3 className="text-[15px] font-semibold text-slate-700">
          Invite a caregiver
        </h3>
        <InviteForm patientId={patientId} />
      </div>
    </section>
  );
}
