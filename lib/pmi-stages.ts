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

export type Milestone = "perfilado" | "apartado" | "cierre";
export const MILESTONES: readonly Milestone[] = ["perfilado", "apartado", "cierre"];

// Substrings sobre el nombre normalizado (minúsculas, sin acentos). Acumulativos:
// una etapa de cierre también es apartado y perfilado.
const PERFILADO_TERMS = [
  "calificado", "cita", "visita", "inversion futura", "cotizacion",
  "apartado", "mensualidades", "escritura", "ganad",
];
const APARTADO_TERMS = ["apartado", "mensualidades", "escritura", "ganad"];
const CIERRE_TERMS = ["escritura", "ganad"];

const LOST_STAGE = "negocio perdido";
const LAST_STAGE_FIELD = "Última Etapa en el Pipeline";

export function normalizeStage(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
