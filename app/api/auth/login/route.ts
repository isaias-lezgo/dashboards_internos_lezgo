// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE,
  COOKIE_OPTIONS,
  PROJECT_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  safeEqual,
  signToken,
} from "@/lib/auth";
import { SCOPES, type AccessScope } from "@/lib/scopes";

export const runtime = "nodejs";

// In-memory per-IP rate limiter. NOTE: on Vercel this state is per-instance and
// resets on cold starts, so it is a soft mitigation against scripted guessing,
// not an airtight distributed limiter (see design doc).
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map<string, { count: number; firstMs: number }>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// Returns true if the IP is currently locked out.
function isLimited(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstMs > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.firstMs > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstMs: now });
  } else {
    rec.count += 1;
  }
}

export async function POST(req: Request) {
  if (!process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_AUTH_SECRET not set");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // A scope whose password env var is absent simply does not exist. That is how a
  // deployment without DOMUS_ACCESS_PASSWORD keeps behaving exactly as it did before
  // scopes existed, with no extra flag to remember.
  const configured = SCOPES.filter((s) => Boolean(process.env[s.passwordEnv]));
  if (configured.length === 0) {
    console.error("[auth] no access scope has its password configured");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const ip = clientIp(req);
  if (isLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let submitted = "";
  try {
    const body = (await req.json()) as { password?: string };
    submitted = body.password ?? "";
  } catch {
    submitted = "";
  }

  // One password per scope, and the password IS the identity: it decides which
  // projects the session may open. Constant-time compare because, unlike the location
  // ids this replaced, these values are real secrets.
  //
  // NO early break, on purpose. Stopping at the first hit would make the response
  // time reveal WHICH password was guessed — the same class of leak safeEqual exists
  // to prevent, so every configured scope is compared on every attempt.
  let matched: AccessScope | null = null;
  for (const scope of configured) {
    if (safeEqual(submitted, process.env[scope.passwordEnv] as string)) matched = scope;
  }

  if (submitted === "" || !matched) {
    recordFailure(ip);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  // Success: clear failures and set the signed gate cookie carrying the scope id. It
  // names no project — the picker sets dash_project separately.
  attempts.delete(ip);
  const expiryMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = await signToken(matched.id, expiryMs);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS });
  // Drop whatever project was selected before. Logging in with the Domus password on
  // a machine that had Grand Center open must land on the picker — requireClient()
  // would refuse that cookie anyway, but as a 401 it reads like a broken session
  // instead of like the fresh start it is.
  res.cookies.set(PROJECT_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res;
}
