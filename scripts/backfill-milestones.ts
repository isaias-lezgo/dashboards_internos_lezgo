// Carga fechas REALES de hitos en la bitácora del PMI, desde un CSV que alguien
// verificó a mano (la tabla de la consultoría). Run:
//   pnpm pmi:backfill <proyecto> <csv>            → solo muestra el plan
//   pnpm pmi:backfill <proyecto> <csv> --apply    → lo escribe
//
// La bitácora es insert-only y la app nunca la actualiza; este script es la
// excepción explícita, y solo toca filas ESTIMADAS: una fecha exacta que ya
// esté en la bitácora nunca se pisa (se reporta y se salta). Regla extra: un
// perfilamiento no puede ser posterior al apartado de la misma oportunidad,
// así que si el estimado quedó después, se recorre al día del apartado.
//
// CSV: opportunity_id,milestone,date[,note] — fecha YYYY-MM-DD en día local
// (America/Mexico_City); se guarda al mediodía local para que localDay la lea
// en ese día sin importar la zona del servidor.
//
// main() y no top-level await: el paquete es CJS.
import { readFileSync } from "node:fs";
import { getClientById } from "../lib/clients";
import { getSql, isDbConfigured } from "../lib/db";
import { MILESTONES, type Milestone } from "../lib/pmi-stages";

interface CsvRow { opportunityId: string; milestone: Milestone; date: string; note: string }

function parseCsv(path: string): CsvRow[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const [header, ...body] = lines;
  if (!header.startsWith("opportunity_id,milestone,date")) throw new Error(`Encabezado inesperado: ${header}`);
  return body.map((line, i) => {
    const [opportunityId, milestone, date, ...rest] = line.split(",");
    if (!opportunityId || !MILESTONES.includes(milestone as Milestone) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Fila ${i + 2} inválida: ${line}`);
    }
    return { opportunityId, milestone: milestone as Milestone, date, note: rest.join(",") };
  });
}

// Mediodía en CDMX (UTC-6, sin horario de verano desde 2022).
const localNoon = (day: string) => `${day}T18:00:00.000Z`;
const dayOf = (iso: string) => new Date(new Date(iso).getTime() - 6 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const [projectId, csvPath, flag] = process.argv.slice(2);
  if (!projectId || !csvPath) throw new Error("uso: pmi:backfill <proyecto> <csv> [--apply]");
  const apply = flag === "--apply";
  const client = getClientById(projectId);
  if (!client) throw new Error(`Proyecto desconocido: ${projectId}`);
  if (!isDbConfigured()) throw new Error("DATABASE_URL no configurada");
  const rows = parseCsv(csvPath);
  const sql = getSql();

  const oppIds = [...new Set(rows.map((r) => r.opportunityId))];
  const existing = await sql`
    SELECT opportunity_id, milestone, reached_at, estimated
      FROM opportunity_milestones
     WHERE project_id = ${client.id} AND opportunity_id = ANY(${oppIds}::text[])
  `;
  const known = new Map<string, { reachedAt: string; estimated: boolean }>();
  for (const r of existing) {
    known.set(`${r.opportunity_id} ${r.milestone}`, { reachedAt: new Date(r.reached_at).toISOString(), estimated: Boolean(r.estimated) });
  }

  type Change = { opportunityId: string; milestone: Milestone; reachedAt: string; estimated: boolean; was: string; note: string };
  const inserts: Change[] = [];
  const updates: Change[] = [];
  const skipped: string[] = [];

  for (const r of rows) {
    const key = `${r.opportunityId} ${r.milestone}`;
    const cur = known.get(key);
    const reachedAt = localNoon(r.date);
    if (!cur) {
      inserts.push({ ...r, reachedAt, estimated: false, was: "(sin fila)" });
    } else if (cur.estimated) {
      updates.push({ ...r, reachedAt, estimated: false, was: `${dayOf(cur.reachedAt)} est.` });
    } else {
      skipped.push(`${key}: ya exacta (${dayOf(cur.reachedAt)}), no se pisa`);
    }
    known.set(key, { reachedAt, estimated: false });
  }

  // Un perfilamiento estimado después del apartado real se recorre al apartado.
  for (const r of rows) {
    if (r.milestone !== "apartado") continue;
    const perf = known.get(`${r.opportunityId} perfilado`);
    const apartado = known.get(`${r.opportunityId} apartado`)!;
    if (perf && perf.estimated && perf.reachedAt > apartado.reachedAt) {
      updates.push({ opportunityId: r.opportunityId, milestone: "perfilado", reachedAt: apartado.reachedAt, estimated: true, was: `${dayOf(perf.reachedAt)} est.`, note: `${r.note} · perfilado ≤ apartado` });
      known.set(`${r.opportunityId} perfilado`, { reachedAt: apartado.reachedAt, estimated: true });
    }
  }

  console.log(`Proyecto ${client.id} · ${rows.length} filas del CSV · ${existing.length} filas en la bitácora`);
  for (const c of inserts) console.log(`  + ${c.milestone.padEnd(11)} ${dayOf(c.reachedAt)}  ${c.was.padEnd(16)} ${c.note}`);
  for (const c of updates) console.log(`  ~ ${c.milestone.padEnd(11)} ${dayOf(c.reachedAt)}${c.estimated ? " est." : "     "}  era ${c.was.padEnd(16)} ${c.note}`);
  for (const s of skipped) console.log(`  = ${s}`);

  if (!apply) {
    console.log(`\nPlan: ${inserts.length} inserciones, ${updates.length} actualizaciones, ${skipped.length} saltadas. Corre con --apply para escribir.`);
    return;
  }
  for (const c of inserts) {
    await sql`
      INSERT INTO opportunity_milestones (project_id, opportunity_id, milestone, reached_at, estimated)
      VALUES (${client.id}, ${c.opportunityId}, ${c.milestone}, ${c.reachedAt}::timestamptz, ${c.estimated})
      ON CONFLICT (project_id, opportunity_id, milestone) DO NOTHING
    `;
  }
  for (const c of updates) {
    await sql`
      UPDATE opportunity_milestones
         SET reached_at = ${c.reachedAt}::timestamptz, estimated = ${c.estimated}
       WHERE project_id = ${client.id} AND opportunity_id = ${c.opportunityId} AND milestone = ${c.milestone}
         AND estimated = true
    `;
  }
  console.log(`\n✅ Escritas ${inserts.length} inserciones y ${updates.length} actualizaciones. El panel las ve en el siguiente sync (botón Actualizar).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
