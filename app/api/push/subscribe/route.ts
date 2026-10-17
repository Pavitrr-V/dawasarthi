import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 15;

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

/**
 * Saves (POST) or removes (DELETE) the browser's push subscription for the
 * signed-in user.
 *
 * Uses the caller's own Supabase client so RLS (`push_subscriptions_*_self`)
 * guarantees a user can only ever touch their own rows. `endpoint` is unique,
 * so re-subscribing on the same device updates in place.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That subscription is not valid." },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    console.error("[push/subscribe] upsert failed", {
      message: error.message,
      code: error.code,
    });
    return NextResponse.json(
      { error: "Could not save notifications. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That subscription is not valid." },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", user.id)
    .eq("endpoint", parsed.data.endpoint);

  if (error) {
    return NextResponse.json(
      { error: "Could not turn notifications off." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
