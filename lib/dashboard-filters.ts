// Los filtros de atributo de la barra global (Status, Asesor, Origen de lead,
// Tipo de pauta), compartidos por los paneles de Marketing y Ventas.
//
// Este módulo es puro y es la ÚNICA fuente de verdad de los cuatro criterios:
// cómo se resuelve el valor de cada uno sobre una oportunidad o un contacto, y
// cómo el conjunto de oportunidades supervivientes arrastra al resto de los
// datasets. No re-inlinees ninguna de estas reglas en un componente.
//
// El modelo es una CASCADA POR CONTACTO. Los filtros se evalúan una sola vez
// sobre oportunidades; de las supervivientes sale un conjunto de contactos, y ese
// conjunto recorta citas, tareas, pautas y mensajes — que ya se relacionan por
// `contactId`. Así los KPIs de un panel filtrado hablan todos del mismo universo.

import type { Appointment, Contact, Message, Opportunity, Pauta, Task } from "./types"
import { isWonOpp } from "./opportunity-status"

// ── Vocabulario ────────────────────────────────────────────────────────────

export type StatusKey = "open" | "won" | "lost" | "abandoned"

export const STATUS_ORDER: StatusKey[] = ["open", "won", "lost", "abandoned"]

export const STATUS_LABELS: Record<StatusKey, string> = {
  open: "Abierto",
  won: "Ganado",
  lost: "Perdido",
  abandoned: "Abandonado",
}

/**
 * Cubos para "el registro no dice". Se muestran como una opción más — un lead sin
 * asesor asignado es un hallazgo, no un hueco que convenga esconder — pero se
 * ordenan al final de su lista: son residuo, no señal.
 */
export const SIN_ASESOR = "Sin asignar"
export const SIN_ORIGEN = "Sin origen"
export const SIN_PAUTA = "Sin pauta"

const RESIDUE_VALUES = new Set<string>([SIN_ASESOR, SIN_ORIGEN, SIN_PAUTA])

export interface DashboardFilters {
  status: StatusKey[]
  advisors: string[]
  origins: string[]
  pautaTypes: string[]
}

/** Arreglo vacío = "todos". Ningún filtro activo deja los datasets intactos. */
export const EMPTY_FILTERS: DashboardFilters = {
  status: [],
  advisors: [],
  origins: [],
  pautaTypes: [],
}

export function hasActiveFilters(f: DashboardFilters): boolean {
  return (
    f.status.length > 0 ||
    f.advisors.length > 0 ||
    f.origins.length > 0 ||
    f.pautaTypes.length > 0
  )
}

export function countActiveFilters(f: DashboardFilters): number {
  return f.status.length + f.advisors.length + f.origins.length + f.pautaTypes.length
}

// ── Resolución de cada criterio ────────────────────────────────────────────

/**
 * La partición de status del panel, no el campo crudo de GHL.
 *
 * Varias sub-cuentas nunca ponen `status: "won"` y registran la venta moviendo la
 * oportunidad a una etapa tardía ("09. Negocio Ganado") — por eso existe
 * `isWonOpp`. Filtrar por el campo crudo devolvería cero "Ganado" en esas cuentas
 * mientras la tarjeta KPI de al lado muestra decenas. Esto reproduce exactamente
 * la partición que calculan los paneles.
 */
export function statusKey(opp: Opportunity): StatusKey {
  if (isWonOpp(opp)) return "won"
  if (opp.status === "lost") return "lost"
  if (opp.status === "abandoned") return "abandoned"
  return "open"
}

/** `assignedTo` ya viene resuelto a nombre de usuario por lib/sync.ts. */
export function advisorOf(x: { assignedTo?: string }): string {
  return x.assignedTo?.trim() || SIN_ASESOR
}

// El campo se llama distinto en cada sub-cuenta ("Origen de Lead", "Origen del
// Lead", "ORIGEN DE LEAD"…), así que se busca por substring en vez de por clave
// exacta. lib/sync.ts sí usa la clave exacta al copiarlo del contacto a la
// oportunidad (`originPlatform`), y por eso ese valor queda como último recurso
// y no como fuente principal.
function isOrigenField(name: string): boolean {
  const n = name.toLowerCase()
  return n.includes("origen") && n.includes("lead")
}

// Un campo de opción múltiple guarda un string[]: el registro pertenece a TODOS
// sus valores, y basta que uno esté seleccionado para pasar el filtro.
function origenValues(resolved?: Record<string, string | string[]>): string[] {
  if (!resolved) return []
  const out: string[] = []
  for (const [name, val] of Object.entries(resolved)) {
    if (!isOrigenField(name)) continue
    for (const v of Array.isArray(val) ? val : [val]) {
      const s = String(v ?? "").trim()
      if (s) out.push(s)
    }
  }
  return out
}

/**
 * Origen de lead de una oportunidad: su propio campo personalizado, con fallback
 * al del contacto. Nunca devuelve vacío — sin señal, cae en SIN_ORIGEN.
 */
export function originsOfOpportunity(opp: Opportunity, contact?: Contact): string[] {
  const own = origenValues(opp.customFieldsResolved)
  if (own.length) return own
  const fromContact = origenValues(contact?.customFieldsResolved)
  if (fromContact.length) return fromContact
  // Último recurso: el valor que lib/sync.ts ya copió del contacto. Solo aporta
  // algo cuando el contacto fue sintetizado desde la oportunidad y no trae sus
  // campos personalizados.
  const surfaced = opp.originPlatform?.trim()
  return surfaced ? [surfaced] : [SIN_ORIGEN]
}

export function originsOfContact(contact: Contact): string[] {
  const own = origenValues(contact.customFieldsResolved)
  return own.length ? own : [SIN_ORIGEN]
}

/**
 * contactId → el `tipo` de su pauta MÁS ANTIGUA. Espejo deliberado de
 * `buildPautaNameByContact` en lib/pauta.ts: cuando el sujeto es una oportunidad
 * hay que elegir un tipo entre los varios que puede tener el contacto, y el
 * criterio es el mismo que ya usa el nombre de campaña — la primera.
 *
 * Debe construirse sobre el historial COMPLETO de pautas, no sobre el filtrado
 * por fecha, o una pauta vieja dejaría de clasificar a su contacto.
 */
export function buildFirstPautaTipoByContact(pautas: Pauta[]): Map<string, string> {
  const earliest = new Map<string, { at: number; tipo: string }>()
  for (const p of pautas) {
    if (!p.contactId) continue
    const at = Number(new Date(p.createdAt)) || 0
    const current = earliest.get(p.contactId)
    if (current && current.at <= at) continue
    earliest.set(p.contactId, { at, tipo: p.tipo?.trim() || "Sin tipo" })
  }
  const out = new Map<string, string>()
  for (const [contactId, v] of earliest) out.set(contactId, v.tipo)
  return out
}

// ── Contexto ───────────────────────────────────────────────────────────────

/**
 * Los índices que los predicados necesitan. Se construye una vez por cambio de
 * dataset, sobre los arreglos COMPLETOS (sin filtrar por fecha), porque tanto el
 * contacto de una oportunidad como la primera pauta de un contacto pueden caer
 * fuera de la ventana activa.
 */
export interface FilterContext {
  contactById: Map<string, Contact>
  firstPautaTipoByContact: Map<string, string>
}

export function buildFilterContext(
  allContacts: Contact[],
  allPautas: Pauta[],
): FilterContext {
  const contactById = new Map<string, Contact>()
  for (const c of allContacts) contactById.set(c.id, c)
  return { contactById, firstPautaTipoByContact: buildFirstPautaTipoByContact(allPautas) }
}

// ── Predicados ─────────────────────────────────────────────────────────────

function anySelected(values: string[], selected: string[]): boolean {
  return values.some((v) => selected.includes(v))
}

export function pautaTipoOfContact(contactId: string | undefined, ctx: FilterContext): string {
  if (!contactId) return SIN_PAUTA
  return ctx.firstPautaTipoByContact.get(contactId) ?? SIN_PAUTA
}

/** O dentro de cada filtro, Y entre filtros. */
export function opportunityPasses(
  opp: Opportunity,
  f: DashboardFilters,
  ctx: FilterContext,
): boolean {
  if (f.status.length && !f.status.includes(statusKey(opp))) return false
  if (f.advisors.length && !f.advisors.includes(advisorOf(opp))) return false
  if (f.origins.length) {
    const values = originsOfOpportunity(opp, ctx.contactById.get(opp.contactId))
    if (!anySelected(values, f.origins)) return false
  }
  if (f.pautaTypes.length && !f.pautaTypes.includes(pautaTipoOfContact(opp.contactId, ctx))) {
    return false
  }
  return true
}

/**
 * Lectura de los filtros sobre un contacto SIN oportunidades en la ventana
 * activa. Sin esto, tocar cualquier filtro borraría a todo contacto sin
 * oportunidad y la métrica "Leads sin oportunidad" daría siempre 0 — una
 * respuesta falsa, no un cero real.
 *
 * Tres de los cuatro criterios sí existen a nivel contacto: `assignedTo` es suyo,
 * el campo "Origen de Lead" es originalmente suyo (lib/sync.ts lo copia a la
 * oportunidad, no al revés) y la primera pauta es contact-level por construcción.
 * Status es el único exclusivo de la oportunidad: un contacto que nunca tuvo una
 * no puede estar "Ganado", así que con ese filtro activo no pasa. Ahí el cero es
 * real.
 */
export function orphanContactPasses(
  c: Contact,
  f: DashboardFilters,
  ctx: FilterContext,
): boolean {
  if (f.status.length) return false
  if (f.advisors.length && !f.advisors.includes(advisorOf(c))) return false
  if (f.origins.length && !anySelected(originsOfContact(c), f.origins)) return false
  if (f.pautaTypes.length && !f.pautaTypes.includes(pautaTipoOfContact(c.id, ctx))) return false
  return true
}

// ── La cascada ─────────────────────────────────────────────────────────────

export interface FilterableDatasets {
  opportunities: Opportunity[]
  contacts: Contact[]
  appointments: Appointment[]
  tasks: Task[]
  pautas: Pauta[]
  messages: Message[]
}

export interface FilterResult extends FilterableDatasets {
  /** null cuando no hay filtros activos: nada se recortó por contacto. */
  allowedContactIds: Set<string> | null
  /** Oportunidades antes de los filtros de atributo, para el contador "N de M". */
  totalOpportunities: number
}

/**
 * Recibe los datasets YA filtrados por fecha y aplica los filtros de atributo.
 *
 * Sin filtros activos devuelve los MISMOS arreglos por referencia, para que los
 * memos aguas abajo no se invaliden y el panel se comporte exactamente como antes
 * de que existiera esta barra.
 */
export function applyDashboardFilters(
  data: FilterableDatasets,
  f: DashboardFilters,
  ctx: FilterContext,
): FilterResult {
  const totalOpportunities = data.opportunities.length
  if (!hasActiveFilters(f)) {
    return { ...data, allowedContactIds: null, totalOpportunities }
  }

  const opportunities = data.opportunities.filter((o) => opportunityPasses(o, f, ctx))

  // "Sin oportunidad" se mide contra la ventana de fecha, no contra el historial:
  // es la misma definición que ya usan los paneles al contar leads sin
  // oportunidad, y desviarse aquí haría que dos números de la misma pantalla
  // discreparan.
  const hasOppInWindow = new Set<string>()
  for (const o of data.opportunities) if (o.contactId) hasOppInWindow.add(o.contactId)

  const ownersOfSurvivors = new Set<string>()
  for (const o of opportunities) if (o.contactId) ownersOfSurvivors.add(o.contactId)

  const contacts = data.contacts.filter(
    (c) =>
      ownersOfSurvivors.has(c.id) ||
      (!hasOppInWindow.has(c.id) && orphanContactPasses(c, f, ctx)),
  )

  // Un contacto puede quedar fuera de la ventana de fecha de contactos y aun así
  // ser dueño de una oportunidad superviviente; sus citas y mensajes siguen
  // siendo parte de la historia que el panel está contando.
  const allowedContactIds = new Set(ownersOfSurvivors)
  for (const c of contacts) allowedContactIds.add(c.id)

  const byContact = <T extends { contactId?: string }>(items: T[]): T[] =>
    // Un registro sin contactId no es atribuible a nadie, así que ningún filtro
    // puede evaluarse sobre él. Se cae. Son un defecto de datos (relación rota
    // del escenario de Make) y siguen visibles en la vista sin filtros.
    items.filter((x) => !!x.contactId && allowedContactIds.has(x.contactId))

  return {
    opportunities,
    contacts,
    appointments: byContact(data.appointments),
    tasks: byContact(data.tasks),
    pautas: byContact(data.pautas),
    messages: byContact(data.messages),
    allowedContactIds,
    totalOpportunities,
  }
}

// ── Opciones de los menús ──────────────────────────────────────────────────

export interface FilterOption {
  value: string
  label: string
  count: number
}

export interface FilterOptions {
  status: FilterOption[]
  advisors: FilterOption[]
  origins: FilterOption[]
  pautaTypes: FilterOption[]
}

function tally(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

// Por volumen desc, con los cubos de residuo ("Sin asignar", "Sin origen", "Sin
// pauta") clavados al final sin importar su tamaño — el mismo criterio que usa
// groupCampaignsByFamily en lib/pauta.ts.
function sortOptions(counts: Map<string, number>): FilterOption[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => {
      const ra = RESIDUE_VALUES.has(a.value) ? 1 : 0
      const rb = RESIDUE_VALUES.has(b.value) ? 1 : 0
      if (ra !== rb) return ra - rb
      return b.count - a.count || a.value.localeCompare(b.value, "es")
    })
}

/**
 * Las opciones se derivan de las oportunidades filtradas SOLO por fecha, nunca de
 * las ya filtradas por atributo: si se recalcularan sobre el resultado, elegir
 * "Ganado" borraría del menú a los demás status y no habría forma de volver.
 */
export function buildFilterOptions(
  dateFilteredOpportunities: Opportunity[],
  ctx: FilterContext,
): FilterOptions {
  const status = new Map<string, number>()
  const advisors = new Map<string, number>()
  const origins = new Map<string, number>()
  const pautaTypes = new Map<string, number>()

  for (const o of dateFilteredOpportunities) {
    tally(status, statusKey(o))
    tally(advisors, advisorOf(o))
    for (const v of originsOfOpportunity(o, ctx.contactById.get(o.contactId))) tally(origins, v)
    tally(pautaTypes, pautaTipoOfContact(o.contactId, ctx))
  }

  return {
    // Status conserva su orden canónico: es una partición fija de cuatro cubos,
    // y reordenarla por volumen haría que la lista bailara entre proyectos.
    status: STATUS_ORDER.filter((k) => status.has(k)).map((k) => ({
      value: k,
      label: STATUS_LABELS[k],
      count: status.get(k) ?? 0,
    })),
    advisors: sortOptions(advisors),
    origins: sortOptions(origins),
    pautaTypes: sortOptions(pautaTypes),
  }
}

// ── Etiqueta para la portada del PDF ───────────────────────────────────────

function summarize(label: string, values: string[]): string | null {
  if (values.length === 0) return null
  if (values.length <= 2) return `${label}: ${values.join(", ")}`
  return `${label}: ${values[0]} +${values.length - 1}`
}

/**
 * Resumen corto de los filtros activos, para la portada del reporte. Un PDF
 * recortado a un asesor que no lo declara miente. null cuando no hay filtros.
 */
export function describeFilters(f: DashboardFilters): string | null {
  const parts = [
    summarize("Status", f.status.map((s) => STATUS_LABELS[s])),
    summarize("Asesor", f.advisors),
    summarize("Origen", f.origins),
    summarize("Tipo de pauta", f.pautaTypes),
  ].filter(Boolean) as string[]
  return parts.length ? parts.join(" · ") : null
}
