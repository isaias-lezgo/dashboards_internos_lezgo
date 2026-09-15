// lib/pmi-ledger-store.ts
// SQL de la bitácora de hitos. Server-only, como sync-store.ts.
//
// Insert-only: ON CONFLICT DO NOTHING, porque la primera fecha manda y dos syncs
// concurrentes (el candado de project_sync se auto-sana a los 10 min) no deben
// pisarse ni fallar. La app nunca actualiza ni borra aquí — la única función
// que borra está restringida a los ids sintéticos del script de verificación.
import { getSql } from "./db";
import type { ClientConfig } from "./clients";
import type { MilestoneRow } from "./pmi-ledger";
import type { Milestone } from "./pmi-stages";

// Toma el ClientConfig, nunca un string suelto: leer la bitácora de otro
// proyecto mezclaría sus apartados con los de este.
export async function readMilestones(client: ClientConfig): Promise<MilestoneRow[]> {
  const rows = await getSql()`
    SELECT opportunity_id, milestone, reached_at, estimated
      FROM opportunity_milestones
     WHERE project_id = ${client.id}
  `;
  return rows.map((r) => ({
    opportunityId: String(r.opportunity_id),
    milestone: r.milestone as Milestone,
    reachedAt: new Date(r.reached_at).toISOString(),
    estimated: Boolean(r.estimated),
  }));
}

export async function insertMilestones(client: ClientConfig, rows: MilestoneRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = getSql();
  // Lotes de 500: el primer sync de Yconia inserta ~500 filas; el de un proyecto
  // grande podría ser más, y un INSERT con miles de parámetros es frágil.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const projectIds = chunk.map(() => client.id);
    const oppIds = chunk.map((r) => r.opportunityId);
    const milestones = chunk.map((r) => r.milestone);
    const reached = chunk.map((r) => r.reachedAt);
    const estimated = chunk.map((r) => r.estimated);
    await sql`
      INSERT INTO opportunity_milestones (project_id, opportunity_id, milestone, reached_at, estimated)
      SELECT * FROM unnest(
        ${projectIds}::text[], ${oppIds}::text[], ${milestones}::text[],
        ${reached}::timestamptz[], ${estimated}::boolean[]
      )
      ON CONFLICT (project_id, opportunity_id, milestone) DO NOTHING
    `;
  }
}

// Solo para scripts/verify-pmi-ledger.ts. Rechaza cualquier id que no sea
// sintético: la app no borra historia.
export async function deleteMilestonesForVerify(projectId: string): Promise<void> {
  if (!projectId.startsWith("__verify_")) {
    throw new Error(`deleteMilestonesForVerify: id no sintético: ${projectId}`);
  }
  await getSql()`DELETE FROM opportunity_milestones WHERE project_id = ${projectId}`;
}
