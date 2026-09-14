// app/api/meta/connection/route.ts
// Estado de la conexión para la píldora del header. Cualquier sesión con
// proyecto abierto lo lee (la píldora se dibuja para todos); `canManage` dice si
// además puede tocarla. Nunca devuelve el token.
import { requireClient, unauthorized } from "@/lib/session";
import { requireMetaAdmin, forbidden, metaConfigured } from "@/lib/meta-admin";
import { isDbConfigured } from "@/lib/db";
import {
  readMetaConnection,
  readProjectAccounts,
  deleteMetaConnection,
} from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function GET() {
  const client = await requireClient();
  if (!client) return unauthorized();
  const canManage = (await requireMetaAdmin()) !== null;

  if (!metaConfigured()) return Response.json({ connected: false, canManage, reason: "not_configured" });
  if (!isDbConfigured()) return Response.json({ connected: false, canManage, reason: "no_db" });

  let conn;
  let selected: string[];
  try {
    [conn, selected] = await Promise.all([readMetaConnection("ads"), readProjectAccounts(client, "ads")]);
  } catch (err) {
    console.error("[meta] no se pudo leer la conexión:", err);
    return Response.json({ connected: false, canManage, reason: "no_db" });
  }
  if (!conn) {
    return Response.json({
      connected: false,
      canManage,
      reason: process.env.VERCEL_ENV === "preview" ? "preview" : undefined,
    });
  }
  const sel = new Set(selected);
  return Response.json({
    connected: true,
    canManage,
    connectedBy: conn.connectedBy,
    connectedAt: conn.connectedAt,
    tokenKind: conn.tokenKind,
    tokenExpiresAt: conn.tokenExpiresAt,
    accounts: conn.availableAccounts.map((a) => ({ ...a, selected: sel.has(a.id) })),
  });
}

export async function DELETE() {
  if (!(await requireMetaAdmin())) return forbidden();
  try {
    await deleteMetaConnection("ads");
  } catch (err) {
    console.error("[meta] no se pudo desconectar:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
