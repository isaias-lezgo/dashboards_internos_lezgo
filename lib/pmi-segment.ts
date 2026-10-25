// El PMI recortado a una plaza (Plaza Bosques / Meseta). Puro: navegador y
// verify:pmi.
//
// La pestaña Desempeño ignora la barra de filtros global, así que el corte por
// plaza vive aquí y no en lib/dashboard-filters.ts. Lo que sí se comparte es
// CÓMO se lee la plaza de un registro (`segmentOfOpportunity` /
// `segmentOfContact`), para que Marketing y Desempeño no puedan discrepar sobre
// a qué plaza pertenece un lead.
//
// La plaza es del LEAD, no del asesor: casi todos los asesores atienden las dos
// plazas, así que recortar por asesor no separa nada.
//
// - Un registro marcado "Ambas" cuenta en las dos plazas. Por eso Bosques +
//   Meseta puede sumar más que "Todas", que lo cuenta una vez.
// - "No identificado" solo aparece en "Todas": no hay plaza a la cual darlo.
// - Las citas no traen el campo; se juzgan por la plaza de su contacto.

import type { PmiInput } from "./pmi";
import type { Contact } from "./types";
import { NO_IDENTIFICADO, SEGMENT_DEFS, segmentOfContact, segmentOfOpportunity } from "./dashboard-filters";

const PLAZA = SEGMENT_DEFS.find((d) => d.key === "plaza")!;
export const AMBAS = "Ambas";

/**
 * Las plazas que este proyecto distingue, en orden alfabético. Vacío = el
 * proyecto no tiene el campo y el selector no se dibuja (la misma detección por
 * presencia que los criterios por segmento de la barra global).
 */
export function pmiPlazaOptions(input: Pick<PmiInput, "contacts" | "opportunities">): string[] {
  const seen = new Set<string>();
  for (const c of input.contacts) seen.add(segmentOfContact(c, PLAZA));
  const byId = new Map(input.contacts.map((c) => [c.id, c]));
  for (const o of input.opportunities) seen.add(segmentOfOpportunity(o, PLAZA, o.contactId ? byId.get(o.contactId) : undefined));
  seen.delete(NO_IDENTIFICADO);
  seen.delete(AMBAS);
  return [...seen].sort((a, b) => a.localeCompare(b, "es"));
}

/** "Plaza Bosques" → "Bosques": el botón ya está bajo la etiqueta "Plaza". */
export function plazaShortLabel(plaza: string): string {
  return plaza.replace(/^plaza\s+/i, "");
}

/** El input del PMI con solo los registros de `plaza` (más los de "Ambas"). */
export function filterPmiInputByPlaza(input: PmiInput, plaza: string): PmiInput {
  const match = (v: string) => v === plaza || v === AMBAS;
  const byId = new Map<string, Contact>(input.contacts.map((c) => [c.id, c]));
  const contactOk = (id: string | undefined) => {
    const c = id ? byId.get(id) : undefined;
    return c ? match(segmentOfContact(c, PLAZA)) : false;
  };
  return {
    contacts: input.contacts.filter((c) => match(segmentOfContact(c, PLAZA))),
    opportunities: input.opportunities.filter((o) =>
      match(segmentOfOpportunity(o, PLAZA, o.contactId ? byId.get(o.contactId) : undefined))),
    appointments: input.appointments.filter((a) => contactOk(a.contactId)),
    pautas: input.pautas.filter((p) => contactOk(p.contactId)),
  };
}
