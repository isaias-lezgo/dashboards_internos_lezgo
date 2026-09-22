// lib/pmi-stages.ts
// Los tres hitos del PMI, definidos por NOMBRE de etapa. Puro: lo importan el
// sync (servidor) y la pestaña (navegador).
//
// Por nombre y no por número: los cinco proyectos inmobiliarios comparten
// "02. Cliente Calificado" / "06. Apartado" / "08. Proceso de Escritura", pero
// "10." es Negocio Ganado en Yconia e Inversión Futura en Condesa, Plaza Bosques,
// Grand Center y Balvanera. Una regla por número contaría inversiones futuras
// como cierres.
import type { Opportunity, Pipeline } from "./types";
import { localDay } from "./meta-attribution";

export type Milestone = "perfilado" | "apartado" | "cierre";
export const MILESTONES: readonly Milestone[] = ["perfilado", "apartado", "cierre"];

// Substrings sobre el nombre normalizado (minúsculas, sin acentos). Acumulativos:
// una etapa de cierre también es apartado y perfilado.
const PERFILADO_TERMS = [
  "calificado", "cita", "visita", "inversion futura", "cotizacion",
  "apartado", "mensualidades", "escritura", "ganad", "entregad",
];
const APARTADO_TERMS = ["apartado", "mensualidades", "escritura", "ganad", "entregad"];
// "Entregado" (Yconia, 11.) va después de Negocio Ganado: es un cierre ya
// escriturado y entregado, no una etapa aparte.
const CIERRE_TERMS = ["escritura", "ganad", "entregad"];

const LOST_STAGE = "negocio perdido";
const LAST_STAGE_FIELD = "Última Etapa en el Pipeline";

export function normalizeStage(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matches(normalized: string, terms: string[]): boolean {
  return terms.some((t) => normalized.includes(t));
}

// La etapa que se juzga: la actual, o si la oportunidad está perdida, la que
// registró la automatización en "Última Etapa en el Pipeline". Perdida = status
// lost O etapa "Negocio Perdido" (hay cuentas que mueven la etapa sin tocar el
// status). Si el campo dice a su vez "Negocio Perdido" o falta → null: no hay
// hitos que contar.
export function effectiveStage(opp: Opportunity): string | null {
  const current = opp.stage ?? "";
  const lost = opp.status === "lost" || normalizeStage(current) === LOST_STAGE;
  if (!lost) return current || null;
  const raw = opp.customFieldsResolved?.[LAST_STAGE_FIELD];
  const last = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!last || normalizeStage(last) === LOST_STAGE) return null;
  return last;
}

export function milestonesOfStage(stageName: string | null): Set<Milestone> {
  const out = new Set<Milestone>();
  if (!stageName) return out;
  const n = normalizeStage(stageName);
  if (n === LOST_STAGE) return out;
  if (matches(n, PERFILADO_TERMS)) out.add("perfilado");
  if (matches(n, APARTADO_TERMS)) out.add("apartado");
  if (matches(n, CIERRE_TERMS)) out.add("cierre");
  return out;
}

// Decide si el proyecto ve la pestaña: detección por presencia, como los
// segmentos Plaza/Agencia. Exige una etapa de APARTADO y no cualquier hito:
// "Primera Cita" (Lezgo Suite, pipeline de servicios) cae en "cita" y
// encendería el PMI donde no hay nada que medir.
export function projectHasMilestoneStages(pipelines: Pipeline[]): boolean {
  return pipelines.some((p) =>
    p.stages.some((s) => milestonesOfStage(s).has("apartado")),
  );
}

// ── Fechas de apartado y cierre: campos de la oportunidad ─────────────────────
//
// Desde 2026-09-21 los hitos de dinero NO salen de la bitácora ni de la etapa:
// salen de dos campos personalizados de la OPORTUNIDAD que la consultoría
// llena a mano — "Fecha de apartado" y "Fecha de cierre". Sin fecha no hay
// apartado ni cierre, aunque la oportunidad esté en "06. Apartado": la etapa
// dice dónde está hoy, el campo dice cuándo ocurrió, y el PMI cuenta eventos.
// Solo la oportunidad, nunca el contacto — un contacto con dos oportunidades
// no puede tener una sola fecha de apartado.
//
// El nombre se busca normalizado por palabras clave (fecha + apartado / cierre)
// porque cada sub-cuenta capitaliza y acentúa distinto.
export type DateMilestone = "apartado" | "cierre";
const DATE_FIELD_TERMS: Record<DateMilestone, string[]> = {
  apartado: ["fecha", "apartado"],
  cierre: ["fecha", "cierre"],
};

// Convierte el valor del campo a día LOCAL `YYYY-MM-DD`. Un campo DATE de GHL
// llega como fecha desnuda; `new Date("2026-09-21")` la leería como medianoche
// UTC, que en México es el día 20 a las 18:00 — así que se toma tal cual. Solo
// un valor con hora pasa por la zona horaria del panel.
export function fieldDateToLocalDay(raw: string | string[] | undefined): string | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!v) return null;
  const bare = /^(\d{4}-\d{2}-\d{2})(?:$|T00:00:00(?:\.000)?Z$)/.exec(v);
  if (bare) return bare[1];
  if (Number.isNaN(new Date(v).getTime())) return null;
  return localDay(v);
}

// La mitad del sync: un DATE de oportunidad llega en `fieldValueDate` como epoch
// en ms a la MEDIANOCHE UTC del día elegido (medido 2026-09-21 en Lezgo Suite:
// 1789948800000 = 2026-09-21T00:00:00Z). Se guarda como `YYYY-MM-DD` en UTC — el
// día que la persona escogió —, que `fieldDateToLocalDay` toma tal cual. Pasarlo
// por hora local lo correría al día anterior en México.
export function epochToUtcDay(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    // Una cadena ISO ya formada conserva el día que trae.
    const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
    return m ? m[1] : undefined;
  }
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function milestoneDateField(opp: Opportunity, kind: DateMilestone): string | null {
  const fields = opp.customFieldsResolved;
  if (!fields) return null;
  const terms = DATE_FIELD_TERMS[kind];
  for (const [name, raw] of Object.entries(fields)) {
    const n = normalizeStage(name);
    if (!terms.every((t) => n.includes(t))) continue;
    const day = fieldDateToLocalDay(raw);
    if (day) return day;
  }
  return null;
}
