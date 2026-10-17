import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { logAdHocDose } from "@/lib/doses";

export const maxDuration = 15;

const bodySchema = z.object({
  scheduleId: z.string().uuid(),
});

/**
 * Logs an ad-hoc ("Took one now") dose for an as-needed medicine.
 *
 * The caller's own Supabase client is used, so RLS (`dose_logs_insert_owner`,
 * `inventory_update_owner`) enforces ownership on top of the explicit check in
 * `logAdHocDose`.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "patient") {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown medicine." }, { status: 400 });
  }

  const supabase = await createClient();
  const result = await logAdHocDose(
    { scheduleId: parsed.data.scheduleId, userId: user.id },
    supabase
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json({
    ok: true,
    dose_id: result.doseId,
    status: "taken",
    inventory_left: result.inventoryLeft,
  });
}
