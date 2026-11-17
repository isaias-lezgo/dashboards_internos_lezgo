import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { readSyncStatus } from "@/lib/sync-store";

export const runtime = "nodejs";

// El latido del banner "Actualizando datos…". Mientras corre el refresco en
// segundo plano el navegador pregunta aquí cada pocos segundos; la respuesta son
// dos columnas de project_sync, nunca el payload (2.5 MB en gzip), así que
// preguntar seguido no cuesta.
//
// La base no es una dependencia tampoco aquí: sin ella o con ella caída se
// responde "nadie está sincronizando" y el banner se retira solo.
export async function GET() {
  const client = await requireClient();
  if (!client) return unauthorized();

  let status = { syncedAt: null as string | null, syncing: false };
  if (isDbConfigured()) {
    try {
      status = await readSyncStatus(client);
    } catch (err) {
      console.error("[cache] status read failed:", err);
    }
  }
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
