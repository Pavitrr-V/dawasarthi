import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { findNextPendingDose } from "@/lib/doses";
import { doseActionUrl } from "@/lib/push-token";
import {
  sendPushToUser,
  type PushNotificationPayload,
} from "@/lib/push";

export const maxDuration = 30;

/**
 * "Send me a test notification" — pushes to the signed-in user's devices.
 *
 * When the user has an upcoming pending dose, the test attaches the real
 * "Taken / Skip / Snooze 10 min" buttons and a signed action URL, so the whole
 * flow (notification -> action -> POST /api/dose/[id]/action) can be demoed
 * without waiting for a real reminder.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const appPath = user.role === "caregiver" ? "/caregiver" : "/home";

  const payload: PushNotificationPayload = {
    title: "MedScan test notification",
    body: "Push is working. This is how a dose reminder will look.",
    url: appPath,
    tag: "medscan-test",
  };

  let nextDose = null;
  try {
    nextDose = await findNextPendingDose(user.id);
  } catch (error) {
    // No service-role key / DB hiccup: still send a plain test notification.
    console.error("[push/test] could not look up a dose", error);
  }

  if (nextDose) {
    payload.title = "MedScan reminder (test)";
    payload.body = nextDose.medicineName
      ? `Time for ${nextDose.medicineName}. Tap Taken, Skip, or Snooze 10 min.`
      : "Time for your medicine. Tap Taken, Skip, or Snooze 10 min.";
    payload.tag = `dose-${nextDose.id}`;
    payload.doseId = nextDose.id;
    payload.actionUrl = doseActionUrl(nextDose.id, user.id);
    payload.actions = true;
  }

  const result = await sendPushToUser(user.id, payload);

  return NextResponse.json({
    ok: true,
    used_dose: Boolean(nextDose),
    ...result,
  });
}
