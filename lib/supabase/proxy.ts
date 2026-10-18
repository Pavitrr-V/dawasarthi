import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

const PUBLIC_PATHS = ["/login", "/auth", "/demo-alert", "/join"];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

/**
 * Refreshes the Supabase session and enforces optimistic auth redirects.
 * Runs on every request via proxy.ts. Database role checks happen in the
 * server components so the proxy stays fast (cookie/claims only).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Prevent CDNs from caching a response that sets auth cookies.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Verifies the JWT signature and refreshes the session when needed.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims?.sub);

  const { pathname } = request.nextUrl;

  // API routes enforce auth themselves and must return JSON, not a redirect.
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  if (!isAuthenticated && !isPublicPath(pathname) && !isApi) {
    return redirectWithCookies(request, "/login", response);
  }

  // Signed-in users never need the login page.
  if (isAuthenticated && pathname === "/login") {
    return redirectWithCookies(request, "/", response);
  }

  return response;
}

function redirectWithCookies(
  request: NextRequest,
  pathname: string,
  source: NextResponse
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  const redirect = NextResponse.redirect(url);
  for (const cookie of source.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) redirect.headers.set(header, value);
  }
  return redirect;
}
