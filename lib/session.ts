// lib/session.ts
// Node-only. Kept OUT of lib/auth.ts on purpose: auth.ts is imported by Edge
// middleware and must stay pure/runtime-agnostic, and importing the roster there
// would pull it into the Edge bundle.
import { cookies } from "next/headers";
import { ACCESS_COOKIE, PROJECT_COOKIE, verifyToken } from "./auth";
import { getClientById, type ClientConfig } from "./clients";
import { getScope, scopeAllows, type AccessScope } from "./scopes";

// The access scope of the current session: the set of projects the password they
// logged in with unlocks. Re-verifies the cookie rather than trusting anything
// middleware might have injected, for the same reason requireClient does.
export async function currentScope(): Promise<AccessScope | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return getScope(await verifyToken(token));
}

// Re-verifies the signed cookies themselves rather than trusting a header injected
// by middleware — a header would be a spoofing surface, and an HMAC verify costs
// microseconds. Returns null when a cookie is invalid, when the id no longer
// resolves (so removing a project from the roster instantly invalidates the live
// sessions viewing it), or when the project lies outside the session's scope.
export async function requireClient(): Promise<ClientConfig | null> {
  const scope = await currentScope();
  if (!scope) return null;

  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const clientId = await verifyToken(token);
  if (!clientId) return null;

  let client: ClientConfig | null;
  try {
    client = getClientById(clientId);
  } catch (err) {
    // Roster missing/invalid — fail closed rather than serving anyone.
    console.error("[session] Could not load project roster:", err);
    return null;
  }
  if (!client) return null;

  // THE BARRIER. A dash_project cookie signed during a wider session stays
  // cryptographically valid forever, so the signature is not what stops a Domus
  // session from opening Grand Center — this check is. Every GHL-touching route
  // funnels through requireClient(), which is why this is the only place it needs
  // to live, and why it must not be relaxed here "just for one route".
  if (!scopeAllows(scope, client.id)) return null;

  return client;
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
