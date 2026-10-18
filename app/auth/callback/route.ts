import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/caregiver";

// Handles the magic-link / PKCE redirect from Supabase.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Default to the root page, which routes by role; honour a safe
      // same-origin target (e.g. /join?code=...) when one was supplied.
      return NextResponse.redirect(`${origin}${next ?? "/"}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link`);
}
