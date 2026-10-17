import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { applyDoseAction, type DoseAction } from "@/lib/doses";
import { verifyDoseActionToken } from "@/lib/push-token";

export const maxDuration = 15;

const paramsSchema = z.string().uuid();

// Canonical actions are taken | skipped | snooze. "skip" is accepted as a
// legacy alias so already-installed service workers keep working.
const bodySchema = z.object({
  action: z.enum(["taken", "skipped", "skip", "snooze"]),
});

function canonicalAction(
  value: z.infer<typeof bodySchema>["action"]
): DoseAction {
  return value === "skip" ? "skipped" : value;
}

/**
 * Records a dose action ("taken" | "skipped" | "snooze") from the app or from a
 * push notification.
 *
 * Auth is deliberately double-pathed:
 *   1. A signed, short-lived `?token=` minted when the notification was sent
 *      (works with no cookies — iOS, app closed, fresh browser profile).
 *   2. The normal Supabase session cookie, for in-app calls.
 *
 * The token only authorises the dose it names, and `applyDoseAction` re-checks
 * that the dose belongs to a patient owned by the acting user.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!paramsSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Unknown dose." }, { status: 400 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose taken, skipped, or snooze." },
      { status: 400 }
    );
  }
  const action = canonicalAction(parsed.data.action);

  // 1) Signed token from the notification payload.
  const token = request.nextUrl.searchParams.get("token");
  let userId: string | null = null;

  if (token) {
    const payload = verifyDoseActionToken(token);
    if (!payload || payload.dose_id !== id) {
      return NextResponse.json(
        { error: "This action link is no longer valid." },
        { status: 401 }
      );
    }
    userId = payload.user_id;
  } else {
    // 2) Fall back to the signed-in user.
    const user = await getCurrentUser();
    userId = user?.id ?? null;
  }

  if (!userId) {
    return NextResponse.json(
      { error: "Please sign in again." },
      { status: 401 }
    );
  }

  const result = await applyDoseAction({ doseId: id, userId, action });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json({
    ok: true,
    dose_id: result.doseId,
    status: result.status,
    due_at: result.dueAt,
    inventory_left: result.inventoryLeft,
  });
}
