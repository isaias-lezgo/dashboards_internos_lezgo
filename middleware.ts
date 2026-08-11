// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, verifyToken } from "@/lib/auth";
import { getScope } from "@/lib/scopes";

// Runs on every request matched by `config.matcher` below. Verifies the signed
// session cookie. Pages redirect to /login; API routes get a 401 JSON so the
// dashboard fetch fails cleanly instead of receiving an HTML redirect.
export async function middleware(req: NextRequest) {
  // Fail closed if misconfigured.
  if (!process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_AUTH_SECRET not set; denying all requests");
    return denied(req);
  }

  // Verifies the gate cookie and that its payload names a known access scope. It
  // deliberately does NOT resolve the project or the roster, which would drag GHL
  // credentials into the Edge bundle — lib/scopes.ts names projects by id only, and
  // WHICH projects a scope allows is enforced in requireClient(), not here.
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  if (getScope(await verifyToken(token))) return NextResponse.next();
  return denied(req);
}

function denied(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

// Match everything EXCEPT: the login page, the auth API routes, and Next static
// assets / favicon. Note `/login` and `/api/auth` are excluded so they stay
// reachable while unauthenticated — as must the favicon, which the browser
// requests on the login page itself.
export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico|icon.png).*)",
  ],
};
