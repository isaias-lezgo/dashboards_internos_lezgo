// Los filtros de atributo de la barra global (Status, Asesor, Origen de lead,
// Tipo de pauta), más los criterios POR SEGMENTO que sólo existen en algunas
// sub-cuentas (Plaza, Agencia) y el toggle de las campañas de Montse.
// Compartidos por los paneles de Marketing y Ventas.
//
// Este módulo es puro y es la ÚNICA fuente de verdad de todos los criterios:
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
import { buildPautaNameByContact, campaignHeadline, resolveCampaignName } from "./pauta"

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
/** El cubo de residuo de los criterios por segmento. */
export const NO_IDENTIFICADO = "No identificado"

const RESIDUE_VALUES = new Set<string>([SIN_ASESOR, SIN_ORIGEN, SIN_PAUTA, NO_IDENTIFICADO])

// ── Criterios por segmento ─────────────────────────────────────────────────
//
// Status, Asesor, Origen y Tipo de pauta son universales: todo proyecto los
// tiene. Estos NO. Plaza Bosques etiqueta cada oportunidad con la plaza a la que
// pertenece, y Condesa con la agencia que la trajo; nadie más tiene ninguno de
// los dos. En vez de plomear el id del proyecto hasta el componente, el criterio
// se declara por NOMBRE DE CAMPO y su existencia la decide el dato: si ningún
// registro del proyecto trae el campo, `buildFilterOptions` devuelve un menú
// vacío y `MultiSelectFilter` no lo dibuja.
//
// Es la misma regla que ya gobierna las opciones — un valor aparece si y sólo si
// algún registro puede ser seleccionado por él — subida un nivel, al criterio.
//
// La lista vive en código, no en un env var, para que cambiar quién ve qué corte
// quede versionado y revisable en el diff. Lo mismo que lib/scopes.ts.

export interface SegmentDef {
  /** Llave estable: viaja en DashboardFilters.segments y no debe cambiar. */
  key: string
  /** Lo que lee el usuario en la barra. */
  label: string
  /**
   * Nombres EXACTOS del campo personalizado (sin distinguir mayúsculas), en orden
   * de preferencia. Se busca primero en la oportunidad y luego en el contacto, así
   * que la lista puede mezclar campos de ambos niveles.
   */
  fieldNames: string[]
}

export const SEGMENT_DEFS: SegmentDef[] = [
  {
    key: "plaza",
    label: "Plaza",
    // Plaza Bosques / Meseta. El primero es de oportunidad y lo llamaron así
    // literalmente para este panel (86% de cobertura); el segundo es su gemelo de
    // contacto, que cubre 99.4% y además admite "Ambas". El tercero es un campo
    // viejo que discrepa del segundo — sólo último recurso.
    fieldNames: [
      "Bosques o Meseta para Dash",
      "Plaza Bosques o Plaza Meseta",
      "Bosques o Meseta",
    ],
  },
  {
    key: "agencia",
    label: "Agencia",
    // Condesa Cimatario. Existe idéntico en oportunidad y en contacto.
    fieldNames: ["IW o DOMUS"],
  },
]

/**
 * La campaña de Montse dentro de DOMUS (Condesa), como headline — sin la liga ni
 * el id de adset, que cambian con cada creatividad.
 *
 * Es un dato de negocio, no una propiedad de los datos: nada en GHL marca esta
 * campaña, y el headline ROTA cuando cambia el precio de lista. Predecesoras
 * observadas, todas `IW o DOMUS = DOMUS` y sin traslape entre sí:
 *   "Depa Desde $1,860,000 MXN"                    20 jun – 2 jul 2026
 *   "Depa Desde $1,860,000 en Qro"                  3 jul – 14 jul 2026
 *   "Depa en planta baja desde $3.2 MDP en Condesa" 18 jul – 19 ago 2026
 * Cuando suba el precio otra vez hay que actualizar este valor a mano, o el
 * toggle se quedará seleccionando una campaña muerta.
 */
export const MONTSE_CAMPAIGN_HEADLINE = "Depa Desde $1,900,000 en Qro"

/**
 * El segmento cuya presencia dibuja el toggle de Montse: su campaña vive dentro
 * de una agencia, así que el control aparece donde aparece la agencia — hoy,
 * Condesa.
 *
 * Deliberadamente NO se ata a que la campaña tenga leads en la ventana activa: un
 * control que aparece y desaparece al mover las fechas es peor que uno que a
 * veces da cero.
 */
const MONTSE_SEGMENT_KEY = "agencia"

export interface DashboardFilters {
  status: StatusKey[]
  advisors: string[]
  origins: string[]
  pautaTypes: string[]
  /**
   * Los criterios por segmento, por `SegmentDef.key`. Llave ausente o arreglo
   * vacío = "todos", igual que los demás. Es un Record y no cuatro campos fijos
   * porque el conjunto de criterios depende del proyecto.
   */
  segments: Record<string, string[]>
  /** Recorta a la campaña de Montse. Apagado no excluye nada. */
  montse: boolean
}

/** Arreglo vacío = "todos". Ningún filtro activo deja los datasets intactos. */
export const EMPTY_FILTERS: DashboardFilters = {
  status: [],
  advisors: [],
  origins: [],
  pautaTypes: [],
  segments: {},
  montse: false,
}

/** Cuántos valores hay seleccionados entre TODOS los criterios por segmento. */
function segmentSelectionCount(f: DashboardFilters): number {
  let n = 0
  for (const def of SEGMENT_DEFS) n += f.segments[def.key]?.length ?? 0
  return n
}

export function hasActiveFilters(f: DashboardFilters): boolean {
  return (
    f.status.length > 0 ||
    f.advisors.length > 0 ||
    f.origins.length > 0 ||
    f.pautaTypes.length > 0 ||
    f.montse ||
    segmentSelectionCount(f) > 0
  )
}

export function countActiveFilters(f: DashboardFilters): number {
  return (
    f.status.length +
    f.advisors.length +
    f.origins.length +
    f.pautaTypes.length +
    segmentSelectionCount(f) +
    (f.montse ? 1 : 0)
  )
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

/**
 * El valor de un criterio por segmento dentro de un blob de campos ya resueltos
 * por nombre, o undefined si el campo no está.
 *
 * El match del nombre es EXACTO salvo mayúsculas y espacios de orilla, al revés
 * que "Origen de lead", que busca por substring. La diferencia es deliberada: los
 * nombres aquí son literales de una sub-cuenta concreta, y un match laxo haría
 * que un campo ajeno con un nombre parecido inventara un criterio en otro
 * proyecto — justo lo que la detección por presencia no debe permitir.
 *
 * Los campos son de opción única, así que un arreglo se lee por su primer valor.
 */
export function segmentValueIn(
  resolved: Record<string, string | string[]> | undefined,
  def: SegmentDef,
): string | undefined {
  if (!resolved) return undefined
  for (const wanted of def.fieldNames) {
    const target = wanted.toLowerCase()
    for (const [name, val] of Object.entries(resolved)) {
      if (name.trim().toLowerCase() !== target) continue
      const raw = Array.isArray(val) ? val[0] : val
      const sv = String(raw ?? "").trim()
      if (sv) return sv
    }
  }
  return undefined
}

/**
 * Segmento de una oportunidad: su propio campo, con fallback al del contacto —
 * el mismo orden que usa "Origen de lead". Nunca devuelve vacío: sin señal cae en
 * NO_IDENTIFICADO, que es una opción seleccionable del menú y no un hueco.
 */
export function segmentOfOpportunity(
  opp: Opportunity,
  def: SegmentDef,
  contact?: Contact,
): string {
  return (
    segmentValueIn(opp.customFieldsResolved, def) ??
    segmentValueIn(contact?.customFieldsResolved, def) ??
    NO_IDENTIFICADO
  )
}

export function segmentOfContact(c: Contact, def: SegmentDef): string {
  return segmentValueIn(c.customFieldsResolved, def) ?? NO_IDENTIFICADO
}

/**
 * ¿Este nombre de pauta es la campaña de Montse? Se compara por headline, así que
 * las dos variantes de liga/id que Meta genera para la misma campaña cuentan
 * como una sola.
 */
export function isMontseCampaign(name: string | undefined): boolean {
  if (!name) return false
  return campaignHeadline(name).toLowerCase() === MONTSE_CAMPAIGN_HEADLINE.toLowerCase()
}

export function isMontseOpportunity(opp: Opportunity, ctx: FilterContext): boolean {
  return isMontseCampaign(resolveCampaignName(opp, ctx.pautaNameByContact))
}

/**
 * Lectura a nivel contacto: el nombre de campaña de un contacto es el de su
 * PRIMERA pauta, la misma fuente que ya usa `resolveCampaignName` como último
 * eslabón de su cadena.
 */
export function isMontseContact(contactId: string | undefined, ctx: FilterContext): boolean {
  if (!contactId) return false
  return isMontseCampaign(ctx.pautaNameByContact.get(contactId))
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
  /**
   * contactId → sus oportunidades del historial COMPLETO. Solo lo consulta
   * `outOfWindowContactPasses`, para juzgar a un contacto cuyos registros caen en
   * la ventana pero cuyas oportunidades no.
   */
  opportunitiesByContact: Map<string, Opportunity[]>
  /**
   * contactId → nombre de su primera pauta. Lo consume el toggle de Montse, tanto
   * para clasificar oportunidades (como último eslabón de `resolveCampaignName`)
   * como para clasificar contactos sin ella.
   */
  pautaNameByContact: Map<string, string>
}

export function buildFilterContext(
  allContacts: Contact[],
  allPautas: Pauta[],
  allOpportunities: Opportunity[],
): FilterContext {
  const contactById = new Map<string, Contact>()
  for (const c of allContacts) contactById.set(c.id, c)
  const opportunitiesByContact = new Map<string, Opportunity[]>()
  for (const o of allOpportunities) {
    if (!o.contactId) continue
    const arr = opportunitiesByContact.get(o.contactId)
    if (arr) arr.push(o)
    else opportunitiesByContact.set(o.contactId, [o])
  }
  return {
    contactById,
    firstPautaTipoByContact: buildFirstPautaTipoByContact(allPautas),
    opportunitiesByContact,
    pautaNameByContact: buildPautaNameByContact(allPautas),
  }
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
  for (const def of SEGMENT_DEFS) {
    const selected = f.segments[def.key]
    if (!selected?.length) continue
    const contact = ctx.contactById.get(opp.contactId)
    if (!selected.includes(segmentOfOpportunity(opp, def, contact))) return false
  }
  if (f.montse && !isMontseOpportunity(opp, ctx)) return false
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
 *
 * Los criterios por segmento y el de Montse también existen a nivel contacto — el
 * campo de la plaza y el de la agencia son suyos antes que de la oportunidad, y el
 * nombre de campaña sale de su primera pauta —, así que se evalúan igual.
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
  for (const def of SEGMENT_DEFS) {
    const selected = f.segments[def.key]
    if (!selected?.length) continue
    if (!selected.includes(segmentOfContact(c, def))) return false
  }
  if (f.montse && !isMontseContact(c.id, ctx)) return false
  return true
}

/**
 * Lectura de los filtros sobre un contacto que NO cae en la ventana de fechas pero
 * que SÍ tiene registros dentro de ella — una pauta, una cita, una tarea, un
 * mensaje.
 *
 * Pasa de verdad, y no como caso raro: el escenario de Make de Balvanera creó el 3
 * de agosto ocho registros de pauta para contactos entrados en julio. Sus pautas
 * caen en la ventana; su contacto y sus oportunidades, no. Sin esta rama esas ocho
 * desaparecían del panel en cuanto se tocaba CUALQUIER filtro — incluso uno que
 * seleccionara todas las opciones de su menú — y la gráfica "Pautas por canal"
 * caía de 21 a 13 formularios sin que nada explicara la diferencia.
 *
 * Se juzga por sus oportunidades del historial completo, porque la ventana no
 * contiene ninguna: aceptar una oportunidad de fuera de la ventana como fuente del
 * status es el precio de no borrar el registro. Un contacto que nunca tuvo
 * oportunidad cae en la lectura a nivel contacto, igual que un huérfano.
 */
export function outOfWindowContactPasses(
  contactId: string,
  f: DashboardFilters,
  ctx: FilterContext,
): boolean {
  const opps = ctx.opportunitiesByContact.get(contactId)
  if (opps?.length) return opps.some((o) => opportunityPasses(o, f, ctx))
  const c = ctx.contactById.get(contactId)
  // Sin contacto en el roster no hay nada contra qué evaluar el filtro; se cae,
  // igual que un registro sin contactId.
  return c ? orphanContactPasses(c, f, ctx) : false
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

  // Tercera fuente: un registro puede caer en la ventana aunque su contacto y sus
  // oportunidades sean anteriores. Ese contacto no está en `data.contacts` (ya
  // recortado por su propio createdAt) ni entre los dueños de las supervivientes,
  // así que las dos fuentes de arriba lo pierden y su registro se cae en
  // byContact() aunque cumpla el criterio. Se evalúa aparte.
  //
  // No se toca `contacts`: su definición sigue siendo la ventana de fechas, y
  // moverla desplazaría "Leads sin oportunidad".
  const judged = new Set<string>()
  for (const items of [data.pautas, data.appointments, data.tasks, data.messages]) {
    for (const x of items as { contactId?: string }[]) {
      const id = x.contactId
      if (!id || allowedContactIds.has(id) || judged.has(id)) continue
      // Con oportunidades EN la ventana, ellas ya decidieron y no sobrevivieron;
      // readmitirlo por la puerta de atrás contradiría el filtro.
      if (hasOppInWindow.has(id)) continue
      judged.add(id)
      if (outOfWindowContactPasses(id, f, ctx)) allowedContactIds.add(id)
    }
  }

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
  /**
   * Por `SegmentDef.key`. Arreglo vacío = este proyecto no declaró el campo, y la
   * barra no dibuja el criterio.
   */
  segments: Record<string, FilterOption[]>
  /** Si la barra debe dibujar el toggle de las campañas de Montse. */
  montse: boolean
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
 * Las opciones se derivan de los datasets filtrados SOLO por fecha, nunca de los
 * ya filtrados por atributo: si se recalcularan sobre el resultado, elegir
 * "Ganado" borraría del menú a los demás status y no habría forma de volver.
 *
 * La regla que gobierna qué entra al menú: **un valor aparece si y sólo si algún
 * registro puede ser seleccionado por él**. Tallar sólo oportunidades rompía esa
 * equivalencia en una dirección — `orphanContactPasses` evalúa a los contactos sin
 * oportunidad, pero sus valores nunca llegaban al menú, así que eran filtrables e
 * inseleccionables a la vez. En Lezgo Suite (952 contactos contra 22
 * oportunidades) eso escondía 433 leads de TikTok y 913 contactos "Sin asignar":
 * el filtro de Origen simplemente no ofrecía "tiktok".
 *
 * Por eso hay una segunda pasada sobre los contactos de la ventana SIN oportunidad
 * en ella — el mismo conjunto exacto que evalúa `orphanContactPasses`, leído con
 * los mismos predicados a nivel contacto.
 *
 * `count` es entonces "unidades filtrables": oportunidades + contactos huérfanos,
 * que es literalmente lo que la cascada evalúa. Status es la excepción y sigue
 * contando sólo oportunidades, porque es el único criterio que no existe a nivel
 * contacto.
 */
export function buildFilterOptions(
  dateFilteredOpportunities: Opportunity[],
  dateFilteredContacts: Contact[],
  ctx: FilterContext,
): FilterOptions {
  const status = new Map<string, number>()
  const advisors = new Map<string, number>()
  const origins = new Map<string, number>()
  const pautaTypes = new Map<string, number>()

  // Los criterios por segmento se tallan aparte porque además hay que decidir si
  // EXISTEN. `NO_IDENTIFICADO` se le asigna a todo registro sin el campo, así que
  // tallarlo sin más inventaría un menú de un solo valor en los cuatro proyectos
  // que no declararon nada. Por eso se recuerda si se vio al menos un valor real:
  // sin ninguno, el criterio no existe aquí y su menú sale vacío.
  const segmentCounts = new Map<string, Map<string, number>>()
  const segmentSeen = new Set<string>()
  for (const def of SEGMENT_DEFS) segmentCounts.set(def.key, new Map())

  const tallySegments = (value: (def: SegmentDef) => string) => {
    for (const def of SEGMENT_DEFS) {
      const v = value(def)
      if (v !== NO_IDENTIFICADO) segmentSeen.add(def.key)
      tally(segmentCounts.get(def.key)!, v)
    }
  }

  const owners = new Set<string>()
  for (const o of dateFilteredOpportunities) {
    if (o.contactId) owners.add(o.contactId)
    tally(status, statusKey(o))
    tally(advisors, advisorOf(o))
    for (const v of originsOfOpportunity(o, ctx.contactById.get(o.contactId))) tally(origins, v)
    tally(pautaTypes, pautaTipoOfContact(o.contactId, ctx))
    tallySegments((def) => segmentOfOpportunity(o, def, ctx.contactById.get(o.contactId)))
  }

  // Segunda pasada: sólo los huérfanos. Un contacto que ya es dueño de una
  // oportunidad de la ventana aportó por ella y contarlo aquí lo duplicaría.
  for (const c of dateFilteredContacts) {
    if (owners.has(c.id)) continue
    tally(advisors, advisorOf(c))
    for (const v of originsOfContact(c)) tally(origins, v)
    tally(pautaTypes, pautaTipoOfContact(c.id, ctx))
    tallySegments((def) => segmentOfContact(c, def))
  }

  const segments: Record<string, FilterOption[]> = {}
  for (const def of SEGMENT_DEFS) {
    segments[def.key] = segmentSeen.has(def.key)
      ? sortOptions(segmentCounts.get(def.key)!)
      : []
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
    segments,
    montse: segments[MONTSE_SEGMENT_KEY]?.length > 0,
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
    ...SEGMENT_DEFS.map((def) => summarize(def.label, f.segments[def.key] ?? [])),
    f.montse ? "Campañas Montse" : null,
  ].filter(Boolean) as string[]
  return parts.length ? parts.join(" · ") : null
}
