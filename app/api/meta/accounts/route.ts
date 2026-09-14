// app/api/meta/accounts/route.ts
// Qué cuentas de las concedidas mira EL PROYECTO DE LA SESIÓN. Solo el alcance
// `all`. La validación real (que cada id esté en available_accounts) vive en el
// store, no aquí. Una lista vacía es válida: quita Meta a este proyecto.
import { requireClient, unauthorized } from "@/lib/session";
import { requireMetaAdmin, forbidden } from "@/lib/meta-admin";
import { writeProjectAccounts } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await requireMetaAdmin())) return forbidden();
  const client = await requireClient();
  if (!client) return unauthorized();

  let ids: unknown;
  try {
    ids = (await req.json())?.ids;
  } catch {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  let ok: boolean;
  try {
    ok = await writeProjectAccounts(client, "ads", ids as string[]);
  } catch (err) {
    console.error("[meta] no se pudo guardar la asignación:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  if (!ok) return Response.json({ error: "invalid_selection" }, { status: 400 });
  return new Response(null, { status: 204 });
}
