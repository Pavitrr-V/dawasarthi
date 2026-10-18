import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { loadInvitePreview } from "@/lib/caregiver-server";
import {
  isInviteExpired,
  isValidInviteCode,
  joinPath,
  normalizeInviteCode,
} from "@/lib/caregiver";
import { Button, Card, PageHeader } from "@/components/ui";
import { Disclaimer } from "@/components/disclaimer";
import { JoinEntry } from "./join-entry";
import { JoinConsent } from "./join-consent";

export const instant = false;

/** Shared shell so every /join state looks the same. */
function JoinShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <main className="flex-1 px-5 py-8">
        <Link href="/" className="text-2xl font-bold text-slate-900">
          MedScan
        </Link>
        {children}
      </main>
      <Disclaimer className="border-t border-slate-200" />
    </div>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="mt-6 space-y-3 text-center">
      <p className="text-lg font-semibold text-slate-900">{title}</p>
      <p className="text-[15px] text-slate-600">{body}</p>
      {action}
    </Card>
  );
}

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code: rawCode } = await searchParams;
  const code = normalizeInviteCode(rawCode);

  // No (or malformed) code: let the caregiver type or scan one.
  if (!isValidInviteCode(code)) {
    return (
      <JoinShell>
        <PageHeader
          title="Link to a patient"
          subtitle="Enter the code your patient shared with you."
        />
        <JoinEntry initialCode={code} />
      </JoinShell>
    );
  }

  const user = await getCurrentUser();

  // Signed out: keep the code and send them through sign-in first.
  if (!user) {
    return (
      <JoinShell>
        <Notice
          title="Sign in to continue"
          body="Sign in with your caregiver account, then come back to accept this invitation."
          action={
            <Link href={`/login?next=${encodeURIComponent(joinPath(code))}`}>
              <Button className="w-full">Sign in</Button>
            </Link>
          }
        />
      </JoinShell>
    );
  }

  if (user.role !== "caregiver") {
    return (
      <JoinShell>
        <Notice
          title="Caregiver account needed"
          body="You are signed in as a patient. Only caregiver accounts can link to a patient."
          action={
            <Link href="/">
              <Button variant="secondary" className="w-full">
                Go to my account
              </Button>
            </Link>
          }
        />
      </JoinShell>
    );
  }

  const invite = await loadInvitePreview(code);
  if (!invite) {
    return (
      <JoinShell>
        <Notice
          title="Invite not found"
          body="This invite code is not valid. Check the code with your patient and try again."
          action={
            <Link href="/join">
              <Button variant="secondary" className="w-full">
                Enter another code
              </Button>
            </Link>
          }
        />
      </JoinShell>
    );
  }

  // Already claimed by this caregiver.
  if (invite.caregiverUserId === user.id) {
    if (invite.consentGiven && invite.status === "active") {
      return (
        <JoinShell>
          <Notice
            title={`You're linked to ${invite.patientFirstName}`}
            body="Consent is active. Their medicines and dose alerts appear on your dashboard."
            action={
              <Link href="/caregiver">
                <Button className="w-full">Go to dashboard</Button>
              </Link>
            }
          />
        </JoinShell>
      );
    }
    return (
      <JoinShell>
        <Notice
          title="Request sent"
          body={`${invite.patientFirstName} needs to approve your request. You'll see their data only after they do.`}
          action={
            <Link href="/caregiver/patients">
              <Button variant="secondary" className="w-full">
                View my patients
              </Button>
            </Link>
          }
        />
      </JoinShell>
    );
  }

  if (invite.caregiverUserId) {
    return (
      <JoinShell>
        <Notice
          title="Invite already used"
          body="This invitation has already been claimed. Ask your patient for a new code."
        />
      </JoinShell>
    );
  }

  if (invite.status !== "pending" || isInviteExpired(invite.createdAt)) {
    return (
      <JoinShell>
        <Notice
          title="Invite expired"
          body="This invitation is no longer valid. Ask your patient to send a new one."
        />
      </JoinShell>
    );
  }

  return (
    <JoinShell>
      <JoinConsent code={code} patientFirstName={invite.patientFirstName} />
    </JoinShell>
  );
}
