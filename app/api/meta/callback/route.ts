// app/api/meta/callback/route.ts
// El regreso del diálogo de Meta. Verifica el state, canjea el code, averigua qué
// clase de token es, lista las cuentas concedidas y guarda LA fila del
// despliegue. Cualquier falla regresa al panel con ?meta=error&reason=… y NO
// deja nada guardado.
import { cookies } from "next/headers";
import { requireMetaAdmin, forbidden } from "@/lib/meta-admin";
import { verifyState, redirectUriFor, OAUTH_COOKIE } from "@/lib/meta-oauth";
import { safeEqual } from "@/lib/auth";
import { exchangeCode, debugToken, fetchMe, listAdAccounts, MetaApiError } from "@/lib/meta-client";
import { writeMetaConnection } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

type Reason = "state_invalid" | "denied" | "token_exchange" | "token_invalid" | "no_accounts" | "db";

// Siempre a "/", nunca a algo que venga en la petición: sin open redirect. Con
// dash_project puesta, "/" es el panel; sin ella, el picker. La cookie del nonce
// se borra en todos los caminos — es de un solo uso.
function back(req: Request, params: Record<string, string>): Response {
  const url = new URL("/", req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `${OAUTH_COOKIE}=; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

export async function GET(req: Request) {
  const scope = await requireMetaAdmin();
  if (!scope) return forbidden();

  const q = new URL(req.url).searchParams;
  const fail = (reason: Reason) => back(req, { meta: "error", reason });

  const state = await verifyState(q.get("state"));
  // El state tiene que ser del alcance logueado (y ese alcance, `all`): un
  // state ajeno, aunque esté bien firmado, no guarda nada.
  if (!state || state.scopeId !== scope.id || state.product !== "ads") return fail("state_invalid");
  // …y del navegador que empezó el flujo: el nonce de la cookie que dejó
  // /connect tiene que ser el mismo del state.
  const nonceCookie = (await cookies()).get(OAUTH_COOKIE)?.value ?? "";
  if (!nonceCookie || !safeEqual(nonceCookie, state.nonce)) return fail("state_invalid");

  if (q.get("error") || !q.get("code")) return fail("denied");

  let token: string;
  try {
    token = (
      await exchangeCode({
        code: q.get("code")!,
        redirectUri: redirectUriFor(req.url, process.env.META_PUBLIC_ORIGIN),
      })
    ).accessToken;
  } catch (err) {
    console.error("[meta] canje del code falló:", err instanceof Error ? err.message : String(err));
    return fail("token_exchange");
  }

  try {
    const info = await debugToken(token);
    if (!info.isValid) return fail("token_invalid");
    const [me, accounts] = await Promise.all([fetchMe(token), listAdAccounts(token)]);
    if (accounts.length === 0) return fail("no_accounts");

    await writeMetaConnection("ads", {
      token,
      tokenKind: info.type === "SYSTEM_USER" || info.expiresAt === null ? "system_user" : "user",
      tokenExpiresAt: info.expiresAt,
      businessId: null,
      connectedBy: me.name || null,
      availableAccounts: accounts,
    });
  } catch (err) {
    console.error("[meta] no se pudo completar la conexión:", err instanceof Error ? err.message : String(err));
    if (err instanceof MetaApiError) return fail(err.isTokenInvalid ? "token_invalid" : "token_exchange");
    return fail("db");
  }

  return back(req, { meta: "connected" });
}
