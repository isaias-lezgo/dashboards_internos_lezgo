// Builds the CSV for the chart drill drawer's "Exportar" button. The drawer
// renders one of four content modes (members / contacts / pautas /
// opportunities); this mirrors that same selection so the exported file matches
// exactly what the drawer is showing. Joins resolve against the drawer's own
// props (contacts lookup), the same data the UI renders from.

import type { Contact, Opportunity } from "@/lib/types"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import { buildCsv } from "@/lib/csv"
import { isWonOpp } from "@/lib/opportunity-status"
import { pautaContactName, pautaContactPhone } from "@/lib/pauta"

export interface DrillExport {
  filename: string
  csvContent: string
  rowCount: number
}

// Turn a drill title into a filesystem-friendly slug for the filename.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

// El panel filtra y dibuja TODA fecha en la zona horaria de quien mira
// (`resolveDateRange` usa startOfDay/endOfDay locales, y el drawer imprime
// `toLocaleDateString`). El CSV tiene que hablar el mismo idioma. Volcar el ISO
// crudo metía una pauta creada el 6 de septiembre a las 23:36 locales en una
// exportación de "1–6 sep" sellada `2026-09-07T05:36Z`: seis horas por delante
// del filtro que la seleccionó y del CRM contra el que se compara. La fecha se
// leía como del día siguiente, fuera del rango pedido.
const pad2 = (n: number): string => String(n).padStart(2, "0")

// "2026-09-06 23:36" — local, ordenable como texto y legible por Excel/Sheets.
function localTimestamp(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso // texto no fechable: pásalo tal cual
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

// El día local, para el nombre del archivo. `toISOString().slice(0, 10)` nombraba
// el archivo con el día de mañana cada tarde a partir de las 18:00 en México.
function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

const latestOppFor = (contactId: string, opps: Opportunity[]): Opportunity | undefined =>
  opps
    .filter((o) => o.contactId === contactId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

/**
 * Returns the CSV for whatever the drawer is currently showing, or null when
 * there is nothing to export. `contacts` is the drawer's contacts prop, used to
 * resolve names for the opportunities mode.
 */
export function buildDrillExport(drill: DrillState, contacts: Contact[]): DrillExport | null {
  const today = localToday()
  const slug = slugify(drill.title) || "registros"

  const showMembers = (drill.members?.length ?? 0) > 0
  const showContacts = !showMembers && (drill.contactItems?.length ?? 0) > 0
  const showPautas = !showMembers && !showContacts && (drill.pautaItems?.length ?? 0) > 0

  let mode: string
  let headers: string[]
  let rows: Array<Record<string, unknown>>

  if (showMembers) {
    mode = "vendedores"
    headers = ["vendedor", "totalOpps", "ganadas", "ingresos"]
    const opps = drill.opportunities
    rows = drill
      .members!.map((member) => {
        const mine = opps.filter((o) => o.assignedTo === member)
        const won = mine.filter(isWonOpp)
        return {
          vendedor: member,
          totalOpps: mine.length,
          ganadas: won.length,
          ingresos: won.reduce((s, o) => s + o.value, 0),
        }
      })
      .sort((a, b) => (b.totalOpps as number) - (a.totalOpps as number))
  } else if (showContacts) {
    mode = "contactos"
    headers = [
      "nombre", "email", "telefono", "empresa", "ciudad", "estado",
      "fuente", "campana", "asignado", "tags", "creado",
    ]
    rows = drill.contactItems!.map((c) => ({
      nombre: c.name,
      email: c.email ?? "",
      telefono: c.phone ?? "",
      empresa: c.companyName ?? "",
      ciudad: c.city ?? "",
      estado: c.state ?? "",
      fuente: c.source ?? "",
      campana: c.campaign ?? "",
      asignado: c.assignedTo ?? "",
      tags: (c.tags ?? []).join("|"),
      creado: localTimestamp(c.createdAt),
    }))
  } else if (showPautas) {
    mode = "pautas"
    headers = [
      "nombre", "telefono", "tipo", "nombrePauta", "tieneContacto", "creado",
    ]
    rows = drill.pautaItems!.map(({ pauta, contact }) => ({
      nombre: contact?.name ?? pautaContactName(pauta) ?? "",
      telefono: contact?.phone ?? pautaContactPhone(pauta) ?? "",
      tipo: pauta.tipo ?? "",
      nombrePauta: pauta.nombrePauta ?? "",
      tieneContacto: contact ? "sí" : "no",
      creado: localTimestamp(pauta.createdAt),
    }))
  } else {
    mode = "oportunidades"
    headers = [
      "contacto", "oportunidad", "pipeline", "etapa", "status", "valor",
      "asignado", "campana", "fuente", "medio", "motivoPerdido", "creado",
    ]
    rows = drill.opportunities.map((o) => {
      const contact = contacts.find((c) => c.id === o.contactId)
      return {
        contacto: contact?.name ?? "",
        oportunidad: o.name,
        pipeline: o.pipelineName ?? "",
        etapa: o.stage ?? "",
        status: o.status,
        valor: o.value,
        asignado: o.assignedTo ?? "",
        campana: o.campaign ?? "",
        fuente: o.source ?? "",
        medio: o.attributionMedium ?? "",
        motivoPerdido: o.lostReason ?? "",
        creado: localTimestamp(o.createdAt),
      }
    })
  }

  if (rows.length === 0) return null

  // Avoid "oportunidades-oportunidades-…" when the drill title is just the mode
  // (e.g. the summary KPI cards). Chart-row drills carry a distinct title.
  const namePart = slug === mode ? mode : `${mode}-${slug}`

  return {
    filename: `${namePart}-${today}.csv`,
    csvContent: buildCsv(headers, rows),
    rowCount: rows.length,
  }
}
