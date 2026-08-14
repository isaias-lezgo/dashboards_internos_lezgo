"use client"

import { useState, useCallback, useEffect, useMemo } from "react"
import {
  Bar,
  BarChart,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  Cell,
} from "recharts"
import { cn } from "@/lib/utils"
import { CardContent } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import type { Opportunity, Contact, Call, Message, Task, Appointment, Pauta, Pipeline } from "@/lib/types"
import { Users, TrendingUp, Target, DollarSign, CalendarDays } from "lucide-react"
import { PLATFORM_COLORS, PLATFORM_ORDER, platformLabel } from "@/lib/source-platform"
import { isWonOpp } from "@/lib/opportunity-status"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import {
  BRAND_AMBER,
  STRUCTURAL_NAVY,
  CHART_GRID_STROKE,
  chartPaletteColor,
  DashboardShell,
  DashboardCard,
  ChartCardHeader,
  ChartCardContent,
  ChartEmpty,
  ChartHint,
  KpiCard,
  SectionHeader,
  NonZeroTooltipContent,
  PlatformIcon,
} from "./dashboard-ui"
import {
  AppointmentDrillDrawer,
  APPT_DRILL_CLOSED,
  type ApptDrillState,
} from "./appointment-drill-drawer"
import { ExportReportButton } from "./export-report-button"
import { DecisionCycleTable, buildDecisionCycle } from "./decision-cycle-table"
import type { ReportInput, ReportSection } from "@/lib/report"

interface SalesDashboardProps {
  opportunities: Opportunity[]
  /**
   * Full, date-unfiltered opportunity set, used only as a lookup table when a
   * drill-down drawer resolves a contact's linked opportunity. An opportunity
   * can be created outside the window that lands its contact on screen, so the
   * date filter may drop it from `opportunities` even while its contact is
   * shown — resolving the join against the filtered slice would then wrongly
   * show "Sin oportunidad". Charts/KPIs still use the date-filtered
   * `opportunities`. Defaults to `opportunities`.
   */
  allOpportunities?: Opportunity[]
  contacts: Contact[]
  /**
   * Full, date-unfiltered contact set, used only as a lookup table when a
   * drill-down/detail drawer resolves an opportunity's linked contact. A
   * contact can be created before its opportunity, so the date filter may drop
   * it from `contacts` even while the opportunity is in range — resolving the
   * join against the filtered slice would then show "Contacto no encontrado".
   * Charts/KPIs still use the date-filtered `contacts`. Defaults to `contacts`.
   */
  allContacts?: Contact[]
  calls: Call[]
  messages: Message[]
  /**
   * Full, date-unfiltered message set, used only as a lookup table when the
   * detail drawer resolves a contact's conversation. Charts still use the
   * date-filtered `messages`. Defaults to `messages`.
   */
  allMessages?: Message[]
  appointments: Appointment[]
  /**
   * Full, date-unfiltered appointment set, used only as a lookup table when the
   * detail drawer resolves a contact's "Citas". A cita scheduled outside the
   * active window that lands its contact on screen would otherwise be dropped by
   * the date filter, wrongly showing "Sin citas registradas". Charts still use
   * the date-filtered `appointments`. Defaults to `appointments`.
   */
  allAppointments?: Appointment[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  pautas?: Pauta[]
  members?: string[]
  locationId?: string
  /** Sub-account name, used in the exported report's filename. */
  locationName?: string
  /** Label of the active global date filter, shown on the PDF report cover. */
  periodLabel?: string
  /** Resumen de los filtros de atributo activos, si los hay. */
  filtersLabel?: string
}

// Funnel milestones are one quantity draining through stages, so hue carries no
// data: navy frames the prospecting steps, amber marks the outcome worth reading.

const APPT_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  showed:    { label: "Asistió",    color: "#10b981" },
  confirmed: { label: "Confirmada", color: "#335577" },
  new:       { label: "Pendiente",  color: "#F59B1B" },
  noshow:    { label: "No asistió", color: "#ef4444" },
  cancelled: { label: "Cancelada",  color: "#94a3b8" },
  invalid:   { label: "Inválida",   color: "#6b7280" },
}

const KNOWN_APPT_STATUS_ORDER = ["showed", "confirmed", "new", "noshow", "cancelled", "invalid"]

function apptStatusVisual(status: string, fallbackIndex: number): { label: string; color: string } {
  const known = APPT_STATUS_CONFIG[status]
  if (known) return known
  return {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    color: chartPaletteColor(fallbackIndex),
  }
}

// Timeline (Línea de tiempo) — amber for contactos, emerald for oportunidades.
type TimelineGran = "day" | "week" | "month"
const TIMELINE_CONTACTS_COLOR = "#f59e0b"
const TIMELINE_OPPS_COLOR = "#10b981"

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// Monday-anchored start of week (local time).
function startOfWeek(input: Date): Date {
  const d = new Date(input)
  d.setHours(0, 0, 0, 0)
  const offset = (d.getDay() + 6) % 7 // Mon=0 … Sun=6
  d.setDate(d.getDate() - offset)
  return d
}

export function SalesDashboard({ opportunities, allOpportunities, contacts, allContacts, calls, messages = [], allMessages, appointments = [], allAppointments, pipelines = [], tasks = [], pautas = [], members: membersProp = [], locationId = "", locationName, periodLabel, filtersLabel }: SalesDashboardProps) {
  // Lookup table for drawer contact-resolution: the full set when provided,
  // falling back to the date-filtered `contacts` for backward compatibility.
  const lookupContacts = allContacts ?? contacts
  // Lookup table for drawer opportunity-resolution: the full set when provided,
  // falling back to the date-filtered `opportunities` for backward compatibility.
  const lookupOpportunities = allOpportunities ?? opportunities
  // Lookup tables for the detail drawer (conversation + "Citas"): full sets when
  // provided, falling back to the date-filtered props for backward compatibility.
  const lookupMessages = allMessages ?? messages
  const lookupAppointments = allAppointments ?? appointments
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const [apptDrill, setApptDrill] = useState<ApptDrillState>(APPT_DRILL_CLOSED)
  const [matrixBy, setMatrixBy] = useState<"asesor" | "origen">("asesor")
  const [hoveredOrigin, setHoveredOrigin] = useState<number | undefined>(undefined)
  const [timelineGran, setTimelineGran] = useState<TimelineGran>("month")
  // Funnel meters fill from empty on first paint; afterwards they morph in place
  // as the date filter changes, so the motion always reads as the data moving.
  const [funnelReady, setFunnelReady] = useState(false)
  useEffect(() => setFunnelReady(true), [])

  const openDrill = useCallback((title: string, items: Opportunity[], subtitle?: string) => {
    setDrill({ open: true, title, subtitle, opportunities: items })
  }, [])

  const openContactsDrill = useCallback((title: string, items: Contact[], subtitle?: string) => {
    setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
  }, [])

  const kpiMetrics = useMemo(() => {
    const total = opportunities.length
    const won = opportunities.filter(isWonOpp).length
    // Keep status buckets disjoint: a stage-driven win (status "open" but in a
    // "Negocio Ganado"/"Won" stage) counts as won, not open.
    const open = opportunities.filter((o) => o.status === "open" && !isWonOpp(o)).length
    const lost = opportunities.filter((o) => o.status === "lost").length
    const abandoned = opportunities.filter((o) => o.status === "abandoned").length
    const wonRevenue = opportunities.filter(isWonOpp).reduce((sum, o) => sum + o.value, 0)
    // `membersProp` es la plantilla completa de la sub-cuenta, y es la mejor
    // respuesta mientras se ve todo: cubre a quien no tiene oportunidades en la
    // ventana. Pero con un filtro puesto deja de serlo — filtrar a un asesor y
    // seguir leyendo "17 miembros activos" es falso. `filtersLabel` está
    // definido exactamente cuando hay algún filtro de atributo activo.
    const activeMembers = membersProp.length > 0 && !filtersLabel
      ? membersProp.length
      : new Set(opportunities.map((o) => o.assignedTo).filter(Boolean)).size
    const conversionRate = total > 0 ? (won / total) * 100 : 0
    const contactsTotal = contacts.length
    const oppCountByContact = new Map<string, number>()
    for (const o of opportunities) {
      if (o.contactId) oppCountByContact.set(o.contactId, (oppCountByContact.get(o.contactId) ?? 0) + 1)
    }
    const contactIdsInList = new Set(contacts.map((c) => c.id))
    const contactsWithOpportunity = contacts.filter((c) => (oppCountByContact.get(c.id) ?? 0) >= 1).length
    const contactsWithoutOpportunity = contactsTotal - contactsWithOpportunity
    const contactsWithMultipleOpportunities = contacts.filter((c) => (oppCountByContact.get(c.id) ?? 0) > 1).length
    const contactsWithoutOpp = contacts.filter((c) => (oppCountByContact.get(c.id) ?? 0) === 0)
    const oppsWithContact = opportunities.filter((o) => o.contactId && contactIdsInList.has(o.contactId))
    const oppsMultiContact = opportunities.filter((o) => o.contactId && (oppCountByContact.get(o.contactId) ?? 0) > 1)
    return { total, won, open, lost, abandoned, wonRevenue, activeMembers, conversionRate, contactsTotal, contactsWithOpportunity, contactsWithoutOpportunity, contactsWithMultipleOpportunities, contactsWithoutOpp, oppsWithContact, oppsMultiContact }
  }, [opportunities, contacts, membersProp, filtersLabel])

  // ── Embudo: hitos del recorrido del lead (lead → contacto → cita → realizada → ganado) ──
  const funnelData = useMemo(() => {
    const contactedIds = new Set<string>()
    for (const m of messages) if (m.contactId) contactedIds.add(m.contactId)
    for (const c of calls) if (c.contactId) contactedIds.add(c.contactId)
    const apptIds = new Set(appointments.map((a) => a.contactId))
    const showedIds = new Set(
      appointments.filter((a) => a.status === "showed").map((a) => a.contactId)
    )

    const conCita = opportunities.filter((o) => apptIds.has(o.contactId))
    const contactados = opportunities.filter((o) => contactedIds.has(o.contactId))
    const realizadas = opportunities.filter((o) => showedIds.has(o.contactId))
    const ganados = opportunities.filter(isWonOpp)

    // Core milestones come from robust data (creation, appointments, status).
    // The optional ones (conversations coverage, "showed" status hygiene) often
    // undercount in GHL; include them only when they keep the funnel descending,
    // otherwise the step conversions read as nonsense (>100%).
    const stages: Array<{ key: string; label: string; opps: Opportunity[] }> = [
      { key: "leads", label: "Oportunidades recibidas", opps: opportunities },
      ...(contactedIds.size > 0 && contactados.length >= conCita.length
        ? [{ key: "contacted", label: "Contactados", opps: contactados }]
        : []),
      { key: "appt", label: "Con cita agendada", opps: conCita },
      ...(realizadas.length >= ganados.length && realizadas.length <= conCita.length
        ? [{ key: "showed", label: "Cita realizada", opps: realizadas }]
        : []),
      { key: "won", label: "Ganados", opps: ganados },
    ]
    return stages.map((s) => ({
      ...s,
      count: s.opps.length,
      color: s.key === "won" ? BRAND_AMBER : STRUCTURAL_NAVY,
    }))
  }, [opportunities, messages, calls, appointments])

  // ── Histórico mensual (cohorte: sigue a los leads creados en cada mes) ──
  const monthlyFunnel = useMemo(() => {
    const apptContactIds = new Set(appointments.map((a) => a.contactId))
    const byMonth = new Map<string, { leads: Opportunity[]; appts: Appointment[] }>()
    const ensure = (key: string) => {
      if (!byMonth.has(key)) byMonth.set(key, { leads: [], appts: [] })
      return byMonth.get(key)!
    }
    for (const o of opportunities) {
      const key = (o.createdAt ?? "").slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(key)) continue
      ensure(key).leads.push(o)
    }
    for (const a of appointments) {
      const key = (a.startTime ?? "").slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(key)) continue
      ensure(key).appts.push(a)
    }
    // Months that only have appointments (e.g. future citas) would render as
    // all-zero lead columns — keep only months where leads were created.
    const keys = [...byMonth.keys()]
      .filter((k) => (byMonth.get(k)?.leads.length ?? 0) > 0)
      .sort()
      .slice(-6)
    const months = keys.map((key) => {
      const [y, m] = key.split("-").map(Number)
      const e = byMonth.get(key)!
      const conCita = e.leads.filter((o) => apptContactIds.has(o.contactId))
      const ganados = e.leads.filter(isWonOpp)
      return {
        key,
        label: new Date(y, m - 1, 1).toLocaleDateString("es-MX", { month: "short", year: "2-digit" }),
        leads: e.leads,
        appts: e.appts,
        conCita,
        ganados,
        citaRate: e.leads.length > 0 ? (conCita.length / e.leads.length) * 100 : 0,
        cierreRate: e.leads.length > 0 ? (ganados.length / e.leads.length) * 100 : 0,
      }
    })
    const chartData = months.map((m) => ({
      key: m.key,
      label: m.label,
      leads: m.leads.length,
      rate: Math.round(m.citaRate * 10) / 10,
    }))
    return { months, chartData }
  }, [opportunities, appointments])

  // ── Línea de tiempo: contactos y oportunidades creados (X = día/semana/mes) ──
  // Granularity only changes the X-axis bucketing; the top filter governs the dataset.
  const timelineData = useMemo(() => {
    type Bucket = { key: string; label: string; sort: number; contacts: Contact[]; opps: Opportunity[] }
    const buckets = new Map<string, Bucket>()
    const ensure = (d: Date): Bucket => {
      let anchor: Date
      let key: string
      let label: string
      if (timelineGran === "day") {
        anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate())
        key = ymd(anchor)
        label = anchor.toLocaleDateString("es-MX", { day: "numeric", month: "short" })
      } else if (timelineGran === "week") {
        anchor = startOfWeek(d)
        key = ymd(anchor)
        label = anchor.toLocaleDateString("es-MX", { day: "numeric", month: "short" })
      } else {
        anchor = new Date(d.getFullYear(), d.getMonth(), 1)
        key = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}`
        label = anchor.toLocaleDateString("es-MX", { month: "short", year: "2-digit" })
      }
      let b = buckets.get(key)
      if (!b) {
        b = { key, label, sort: anchor.getTime(), contacts: [], opps: [] }
        buckets.set(key, b)
      }
      return b
    }
    for (const c of contacts) {
      const d = new Date(c.createdAt)
      if (isNaN(d.getTime())) continue
      ensure(d).contacts.push(c)
    }
    for (const o of opportunities) {
      const d = new Date(o.createdAt)
      if (isNaN(d.getTime())) continue
      ensure(d).opps.push(o)
    }
    const sorted = [...buckets.values()].sort((a, b) => a.sort - b.sort)
    const chartData = sorted.map((b) => ({
      key: b.key,
      label: b.label,
      contacts: b.contacts.length,
      opps: b.opps.length,
    }))
    return { buckets: sorted, chartData }
  }, [contacts, opportunities, timelineGran])

  // ── Origen de leads (plataforma normalizada) con conversión a cita ──
  const origenData = useMemo(() => {
    const apptIds = new Set(appointments.map((a) => a.contactId))
    const byPlatform = new Map<string, Opportunity[]>()
    for (const o of opportunities) {
      const p = platformLabel(o)
      if (!byPlatform.has(p)) byPlatform.set(p, [])
      byPlatform.get(p)!.push(o)
    }
    const total = opportunities.length
    return PLATFORM_ORDER.filter((p) => byPlatform.has(p)).map((platform) => {
      const opps = byPlatform.get(platform)!
      const citas = opps.filter((o) => apptIds.has(o.contactId))
      return {
        platform,
        opps,
        citas,
        count: opps.length,
        pct: total > 0 ? (opps.length / total) * 100 : 0,
        citaRate: opps.length > 0 ? (citas.length / opps.length) * 100 : 0,
        color: PLATFORM_COLORS[platform] ?? "#6b7280",
      }
    }).sort((a, b) => b.count - a.count)
  }, [opportunities, appointments])

  // ── Resultado de las citas (barra segmentada por estatus) ──
  const apptOutcomeData = useMemo(() => {
    const byStatus = new Map<string, Appointment[]>()
    for (const a of appointments) {
      if (!byStatus.has(a.status)) byStatus.set(a.status, [])
      byStatus.get(a.status)!.push(a)
    }
    const statuses = [...byStatus.keys()].sort((a, b) => {
      const ai = KNOWN_APPT_STATUS_ORDER.indexOf(a)
      const bi = KNOWN_APPT_STATUS_ORDER.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    return statuses.map((status, i) => {
      const appts = byStatus.get(status)!
      return {
        status,
        appts,
        count: appts.length,
        pct: appointments.length > 0 ? (appts.length / appointments.length) * 100 : 0,
        ...apptStatusVisual(status, i),
      }
    })
  }, [appointments])

  // ── Razones de pérdida agrupadas (top 5 + resto) ──
  const lossGroupsData = useMemo(() => {
    const lost = opportunities.filter((o) => o.status === "lost")
    const byReason = new Map<string, Opportunity[]>()
    for (const o of lost) {
      const reason = o.lostReason ?? "Sin razón"
      if (!byReason.has(reason)) byReason.set(reason, [])
      byReason.get(reason)!.push(o)
    }
    const sorted = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)
    const top = sorted.slice(0, 5)
    const rest = sorted.slice(5)
    const groups = top.map(([reason, opps], i) => ({
      reason,
      opps,
      count: opps.length,
      pct: lost.length > 0 ? (opps.length / lost.length) * 100 : 0,
      color: chartPaletteColor(i),
    }))
    if (rest.length > 0) {
      const opps = rest.flatMap(([, o]) => o)
      groups.push({
        reason: `Otras ${rest.length} razones`,
        opps,
        count: opps.length,
        pct: lost.length > 0 ? (opps.length / lost.length) * 100 : 0,
        color: "#6b7280",
      })
    }
    return { groups, totalLost: lost.length }
  }, [opportunities])

  // ── Matriz etapa × (asesor | origen) con intensidad por volumen ──
  const pipelineMatrix = useMemo(() => {
    if (opportunities.length === 0) return null
    const stageOrder: string[] = []
    for (const p of pipelines) for (const s of p.stages) if (!stageOrder.includes(s)) stageOrder.push(s)
    // Stage-driven wins keep status "open"; surface them in the "Ganado" row
    // below rather than as an open stage, so they aren't counted twice.
    const openOpps = opportunities.filter((o) => o.status === "open" && !isWonOpp(o))
    // Derive stage list from ALL opportunities (any status) so stages whose opps
    // have all moved to won/lost still appear as rows (with 0 open counts).
    // Won-stage-named stages (e.g. "Negocio Ganado") are excluded here since they
    // are represented by the aggregate "Ganado" row below.
    const wonStagePattern = /ganad[oa]|\bwon\b/i
    const allActiveStages = [...new Set(
      opportunities.map((o) => o.stage).filter((s) => !wonStagePattern.test(s ?? ""))
    )].sort((a, b) => {
      const ai = stageOrder.indexOf(a)
      const bi = stageOrder.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    type MatrixRow = { label: string; dot: string; kind: "open" | "won" | "abandoned" | "lost"; opps: Opportunity[] }
    const rows: MatrixRow[] = allActiveStages.map((s) => ({
      label: s,
      dot: "#3b82f6",
      kind: "open" as const,
      opps: openOpps.filter((o) => o.stage === s),
    }))
    const statusRows: Array<[Opportunity["status"], string, string, MatrixRow["kind"]]> = [
      ["won", "Ganado", BRAND_AMBER, "won"],
      ["abandoned", "Abandonado", "#94a3b8", "abandoned"],
      ["lost", "Perdido", "#ef4444", "lost"],
    ]
    for (const [status, label, dot, kind] of statusRows) {
      // "won" spans both GHL status and stage-driven wins; the rest stay status-based.
      const opps = status === "won"
        ? opportunities.filter(isWonOpp)
        : opportunities.filter((o) => o.status === status)
      if (opps.length > 0) rows.push({ label, dot, kind, opps })
    }
    const colOf = matrixBy === "origen"
      ? platformLabel
      : (o: Opportunity) => o.assignedTo || "Sin asesor"
    const colTotals = new Map<string, number>()
    for (const o of opportunities) colTotals.set(colOf(o), (colTotals.get(colOf(o)) ?? 0) + 1)
    const cols = matrixBy === "origen"
      ? PLATFORM_ORDER.filter((p) => colTotals.has(p))
      : [...colTotals.keys()].sort((a, b) => (colTotals.get(b) ?? 0) - (colTotals.get(a) ?? 0))
    const cells = rows.map((r) => cols.map((c) => r.opps.filter((o) => colOf(o) === c)))
    let liveMax = 1
    let lostMax = 1
    rows.forEach((r, i) => {
      for (const cellOpps of cells[i]) {
        if (r.kind === "lost") lostMax = Math.max(lostMax, cellOpps.length)
        else liveMax = Math.max(liveMax, cellOpps.length)
      }
    })
    return { rows, cols, cells, colTotals, liveMax, lostMax, total: opportunities.length }
  }, [opportunities, pipelines, matrixBy])

  // PDF report spec from the same memos the charts render (computed on click).
  // One section per card rendered below, in the same order and the same chart
  // form, so the PDF reads as the panel does — with an explanation added.
  const buildReport = useCallback((): ReportInput => {
    const mxn = (v: number) =>
      v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
    const sections: ReportSection[] = []

    if (timelineData.chartData.length > 0) {
      // Daily granularity over a wide filter yields hundreds of buckets; a PDF
      // axis can't carry those, so plot the most recent 30 and say so.
      const MAX_BUCKETS = 30
      const points = timelineData.chartData.slice(-MAX_BUCKETS)
      const truncated = timelineData.chartData.length > points.length
      const granLabel =
        timelineGran === "day" ? "diaria" : timelineGran === "week" ? "semanal" : "mensual"
      sections.push({
        id: "timeline",
        title: "Línea de tiempo de contactos y oportunidades",
        explanation:
          `Cuántos contactos y cuántas oportunidades se crearon en cada periodo, con granularidad ${granLabel}. La distancia entre ambas líneas indica qué proporción de los contactos que entran llega a convertirse en oportunidad.` +
          (truncated ? ` Se grafican los últimos ${points.length} periodos de ${timelineData.chartData.length}.` : ""),
        blocks: [{
          t: "chart", type: "line", valueLabel: "Registros",
          title: `Contactos y oportunidades por periodo (${contacts.length} contactos · ${opportunities.length} oportunidades)`,
          categories: points.map((p) => p.label),
          series: [
            { name: "Contactos", values: points.map((p) => p.contacts) },
            { name: "Oportunidades", values: points.map((p) => p.opps) },
          ],
        }],
      })
    }

    if (funnelData.length > 0) {
      sections.push({
        id: "funnel",
        title: "Recorrido de la oportunidad",
        explanation:
          "El embudo de ventas por hitos: oportunidades recibidas, contactadas, con cita agendada y ganadas. Cada paso muestra cuántas oportunidades sobreviven a esa etapa del recorrido.",
        blocks: [{
          t: "chart", type: "bar", orientation: "h", valueLabel: "Oportunidades",
          title: `Embudo (total: ${kpiMetrics.total})`,
          series: funnelData.map((s) => ({ label: s.label, value: s.count })),
        }],
      })
    }

    if (monthlyFunnel.months.length > 0) {
      sections.push({
        id: "historico",
        title: "Histórico de oportunidades y conversión a cita",
        explanation:
          "Cohorte mensual: cuántas oportunidades se crearon cada mes y qué porcentaje de ellas llegó a agendar cita y a cerrarse. Permite ver si el volumen y la calidad mejoran o empeoran con el tiempo.",
        blocks: [
          {
            t: "chart", type: "line", valueLabel: "Oportunidades",
            title: "Oportunidades creadas por mes",
            series: monthlyFunnel.chartData.map((m) => ({ label: m.label, value: m.leads })),
          },
          {
            t: "table",
            headers: ["Mes", "Oportunidades", "Con cita", "% a cita", "Ganados", "% cierre"],
            rows: monthlyFunnel.months.map((m) => [
              m.label,
              String(m.leads.length),
              String(m.conCita.length),
              `${m.citaRate.toFixed(1)}%`,
              String(m.ganados.length),
              `${m.cierreRate.toFixed(1)}%`,
            ]),
          },
        ],
      })
    }

    if (monthlyFunnel.months.length > 0) {
      // Panel renders this as etapa × mes; keep that orientation in the PDF.
      const ms = monthlyFunnel.months
      sections.push({
        id: "volumen-mes",
        title: "Volumen y conversión por mes",
        explanation:
          "La misma cohorte mensual vista como tabla: cuántas oportunidades se crearon cada mes, cuántas llegaron a cita y cuántas se ganaron, más las dos tasas de conversión. Cada columna sigue a las oportunidades creadas en ese mes.",
        blocks: [{
          t: "table",
          headers: ["Etapa", ...ms.map((m) => m.label)],
          rows: [
            ["Oportunidades creadas", ...ms.map((m) => String(m.leads.length))],
            ["Llegaron a cita", ...ms.map((m) => String(m.conCita.length))],
            ["Ganados", ...ms.map((m) => String(m.ganados.length))],
            ["Tasa Oportunidad → Cita", ...ms.map((m) => `${m.citaRate.toFixed(1)}%`)],
            ["Tasa Oportunidad → Ganado", ...ms.map((m) => `${m.cierreRate.toFixed(1)}%`)],
          ],
        }],
      })
    }

    {
      // Same data the panel's "Ciclo de Decisión" table renders.
      const cycle = buildDecisionCycle(opportunities, lookupContacts, lookupAppointments)
      if (cycle.rows.length > 0 && cycle.stats.fastest && cycle.stats.longest) {
        const MAX_ROWS = 25
        const shown = cycle.rows.slice(0, MAX_ROWS)
        const truncated = cycle.rows.length > shown.length
        const fmt = (iso: string | null) =>
          iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" }) : "—"
        sections.push({
          id: "ciclo",
          title: "Ciclo de decisión (oportunidades ganadas)",
          explanation:
            `Cuántos días transcurren desde que se crea la oportunidad hasta que se gana/aparta, por cada oportunidad ganada del periodo. Promedio general: ${cycle.stats.promedio} días · más rápido: ${cycle.stats.fastest.dias} (${cycle.stats.fastest.cliente}) · más largo: ${cycle.stats.longest.dias} (${cycle.stats.longest.cliente}).` +
            (truncated ? ` Se listan las ${shown.length} de cierre más rápido de ${cycle.rows.length} ganadas.` : ""),
          blocks: [{
            t: "table",
            headers: ["Cliente", "Asesor", "Llegó", "Visitó", "Apartó", "Días", "Origen"],
            rows: shown.map((r) => [
              r.cliente,
              r.asesor,
              fmt(r.llego),
              fmt(r.visito),
              fmt(r.aparto),
              String(r.dias),
              r.origen,
            ]),
          }],
        })
      }
    }

    if (origenData.length > 0) {
      sections.push({
        id: "origen",
        title: "Origen de oportunidades y conversión a cita",
        explanation:
          "De qué plataforma proviene cada oportunidad y qué porcentaje de cada origen llega a agendar una cita. Compara el volumen contra la calidad de cada canal: un origen puede traer muchas oportunidades y aun así convertir poco.",
        blocks: [
          {
            t: "chart", type: "pie", valueLabel: "Oportunidades",
            title: `Origen de oportunidades (total: ${opportunities.length})`,
            series: origenData.map((o) => ({ label: o.platform, value: o.count })),
          },
          {
            t: "table",
            headers: ["Plataforma", "Oportunidades", "% del total", "% a cita"],
            rows: origenData.map((o) => [
              o.platform,
              String(o.count),
              `${o.pct.toFixed(1)}%`,
              `${o.citaRate.toFixed(1)}%`,
            ]),
          },
        ],
      })
    }

    if (pipelineMatrix && pipelineMatrix.rows.length > 0) {
      // The panel's matrix can be far wider than a PDF page; keep the heaviest
      // columns and fold the rest into "Otros" so every opportunity is still counted.
      const MAX_COLS = 6
      const keptCols = pipelineMatrix.cols.slice(0, MAX_COLS)
      const restCols = pipelineMatrix.cols.slice(MAX_COLS)
      const byLabel = matrixBy === "origen" ? "origen del lead" : "asesor asignado"
      sections.push({
        id: "etapas",
        title: "Estado actual del embudo por etapa",
        explanation:
          `Cuántas oportunidades hay hoy en cada etapa del pipeline (las abiertas) y cuántas terminaron ganadas, abandonadas o perdidas, cruzadas contra el ${byLabel}. Es la fotografía actual de la cartera: dónde está detenido el inventario de oportunidades y quién o qué canal lo concentra.` +
          (restCols.length > 0 ? ` Se muestran las ${keptCols.length} columnas de mayor volumen; el resto se agrupa en "Otros".` : ""),
        blocks: [
          {
            t: "chart", type: "bar", stacked: true, orientation: "h", valueLabel: "Oportunidades",
            title: `Etapa × ${matrixBy === "origen" ? "origen" : "asesor"} (total: ${pipelineMatrix.total})`,
            categories: pipelineMatrix.rows.map((r) => r.label),
            series: [
              ...keptCols.map((c, ci) => ({
                name: c,
                values: pipelineMatrix.rows.map((_, ri) => pipelineMatrix.cells[ri][ci].length),
              })),
              ...(restCols.length > 0
                ? [{
                    name: "Otros",
                    values: pipelineMatrix.rows.map((_, ri) =>
                      restCols.reduce((s, _c, i) => s + pipelineMatrix.cells[ri][MAX_COLS + i].length, 0)
                    ),
                  }]
                : []),
            ],
          },
          {
            t: "table",
            headers: ["Etapa / Estado", ...keptCols, ...(restCols.length > 0 ? ["Otros"] : []), "Total"],
            rows: pipelineMatrix.rows.map((r, ri) => [
              r.label,
              ...keptCols.map((_c, ci) => String(pipelineMatrix.cells[ri][ci].length)),
              ...(restCols.length > 0
                ? [String(restCols.reduce((s, _c, i) => s + pipelineMatrix.cells[ri][MAX_COLS + i].length, 0))]
                : []),
              String(r.opps.length),
            ]),
          },
        ],
      })
    }

    if (apptOutcomeData.length > 0) {
      sections.push({
        id: "citas",
        title: "Resultado de las citas",
        explanation:
          "Distribución de las citas agendadas según su estatus final: asistió, confirmada, pendiente, no asistió o cancelada. Mide la efectividad del agendamiento.",
        blocks: [{
          t: "chart", type: "pie", valueLabel: "Citas",
          title: `Citas (total: ${appointments.length})`,
          series: apptOutcomeData.map((s) => ({ label: s.label, value: s.count })),
        }],
      })
    }

    if (lossGroupsData.groups.length > 0) {
      sections.push({
        id: "perdidas",
        title: "Principales razones de pérdida",
        explanation:
          "Las razones más frecuentes por las que se pierden oportunidades. Concentra los esfuerzos de mejora donde más ventas se están cayendo.",
        blocks: [{
          t: "chart", type: "bar", orientation: "h", valueLabel: "Oportunidades",
          title: `Perdidas (total: ${lossGroupsData.totalLost})`,
          series: lossGroupsData.groups.map((g) => ({ label: g.reason, value: g.count })),
        }],
      })
    }

    return {
      reportType: "ventas",
      title: "Reporte de Ventas",
      locationName,
      periodLabel,
      filtersLabel,
      kpis: [
        { label: "Ingreso ganado", value: mxn(kpiMetrics.wonRevenue) },
        { label: "Oportunidades", value: String(kpiMetrics.total) },
        { label: "Ganadas", value: String(kpiMetrics.won) },
        { label: "Conversión", value: `${kpiMetrics.conversionRate.toFixed(1)}%` },
        { label: "Citas", value: String(appointments.length) },
        { label: "Miembros activos", value: String(kpiMetrics.activeMembers) },
      ],
      sections,
    }
  }, [
    timelineData, timelineGran, funnelData, monthlyFunnel, origenData, pipelineMatrix,
    matrixBy, apptOutcomeData, lossGroupsData, kpiMetrics, appointments.length,
    contacts.length, opportunities.length, periodLabel, filtersLabel, locationName,
    opportunities, lookupContacts, lookupAppointments,
  ])

  return (
    <DashboardShell>
      <div className="flex justify-end">
        <ExportReportButton getInput={buildReport} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
        {/* Contactos */}
        <DashboardCard interactive onClick={() => openDrill("Todos los Contactos", kpiMetrics.oppsWithContact)}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Contactos
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-foreground">
                  {kpiMetrics.contactsTotal.toLocaleString("es-MX")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {kpiMetrics.contactsWithOpportunity > 0 && (
                    <span
                      className="inline-flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-75"
                      style={{ background: "#0284c722", color: "#0284c7" }}
                      onClick={(e) => {
                        e.stopPropagation()
                        openDrill("Contactos con oportunidad", kpiMetrics.oppsWithContact)
                      }}
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#0284c7" }} />
                      {kpiMetrics.contactsWithOpportunity} Con oportunidad
                    </span>
                  )}
                  {kpiMetrics.contactsWithoutOpportunity > 0 && (
                    <span
                      className="inline-flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-75"
                      style={{ background: "#94a3b822", color: "#94a3b8" }}
                      onClick={(e) => {
                        e.stopPropagation()
                        openContactsDrill("Contactos sin oportunidad", kpiMetrics.contactsWithoutOpp)
                      }}
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#94a3b8" }} />
                      {kpiMetrics.contactsWithoutOpportunity} Sin oportunidad
                    </span>
                  )}
                  {kpiMetrics.contactsWithMultipleOpportunities > 0 && (
                    <span
                      className="inline-flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-75"
                      style={{ background: "#8b5cf622", color: "#8b5cf6" }}
                      onClick={(e) => {
                        e.stopPropagation()
                        openDrill("Contactos con más de una oportunidad", kpiMetrics.oppsMultiContact)
                      }}
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#8b5cf6" }} />
                      {kpiMetrics.contactsWithMultipleOpportunities} Más de una oportunidad
                    </span>
                  )}
                </div>
              </div>
              <Users className="h-5 w-5 shrink-0 text-[#0284c7]" aria-hidden />
            </div>
          </CardContent>
        </DashboardCard>

        {/* Oportunidades */}
        <DashboardCard interactive onClick={() => openDrill("Todas las Oportunidades", opportunities)}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Oportunidades
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-foreground">
                  {kpiMetrics.total.toLocaleString("es-MX")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {([
                    { key: "open",      label: "Abiertas",    color: "#7c3aed", count: kpiMetrics.open },
                    { key: "won",       label: "Ganadas",     color: "#F59B1B", count: kpiMetrics.won },
                    { key: "lost",      label: "Perdidas",    color: "#ef4444", count: kpiMetrics.lost },
                    { key: "abandoned", label: "Abandonadas", color: "#94a3b8", count: kpiMetrics.abandoned },
                  ] as const).filter((s) => s.count > 0).map((s) => (
                    <span
                      key={s.key}
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ background: s.color + "22", color: s.color }}
                      onClick={(e) => {
                        e.stopPropagation()
                        openDrill(
                          s.label,
                          opportunities.filter((o) => o.status === s.key),
                        )
                      }}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: s.color }}
                      />
                      {s.count} {s.label}
                    </span>
                  ))}
                </div>
              </div>
              <Target className="h-5 w-5 shrink-0 text-[#7c3aed]" aria-hidden />
            </div>
          </CardContent>
        </DashboardCard>

        {/* Ingreso Ganado */}
        <KpiCard
          variant="hero"
          label="Ingreso ganado"
          value={kpiMetrics.wonRevenue.toLocaleString("es-MX", {
            style: "currency",
            currency: "MXN",
            maximumFractionDigits: 0,
          })}
          sublabel={`${kpiMetrics.won} oportunidades ganadas`}
          icon={DollarSign}
          onClick={() =>
            openDrill(
              "Oportunidades Ganadas",
              opportunities.filter(isWonOpp),
              "Ingreso ganado total",
            )
          }
        />

        <KpiCard
          label="Conversión"
          value={`${kpiMetrics.conversionRate.toFixed(1)}%`}
          sublabel={`${kpiMetrics.won} ganadas`}
          icon={TrendingUp}
          onClick={() => openDrill("Oportunidades Ganadas", opportunities.filter(isWonOpp))}
        />
        <KpiCard
          label="Miembros activos"
          value={String(kpiMetrics.activeMembers)}
          icon={Users}
          onClick={() =>
            setDrill({
              open: true,
              title: "Miembros del Equipo",
              subtitle: `${kpiMetrics.activeMembers} asesores`,
              opportunities,
              members:
                membersProp.length > 0
                  ? membersProp
                  : [...new Set(opportunities.map((o) => o.assignedTo).filter(Boolean) as string[])],
            })
          }
        />
        <KpiCard
          label="Citas"
          value={String(appointments.length)}
          sublabel={`${appointments.filter((a) => a.status === "showed").length} realizadas`}
          icon={CalendarDays}
          onClick={() =>
            setApptDrill({ open: true, title: "Todas las citas", appointments })
          }
        />
      </div>

      <DashboardCard>
        <ChartCardHeader
          title="Línea de tiempo de contactos y oportunidades"
          total={`${contacts.length.toLocaleString("es-MX")} contactos · ${opportunities.length.toLocaleString("es-MX")} oportunidades`}
          actions={
            <div className="flex rounded-lg border border-border bg-muted p-0.5">
              {([
                { key: "day" as const, label: "Diario" },
                { key: "week" as const, label: "Semanal" },
                { key: "month" as const, label: "Mensual" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    timelineGran === opt.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setTimelineGran(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          }
        />
        <ChartCardContent>
          {timelineData.chartData.length === 0 ? (
            <ChartEmpty message="Sin datos para la línea de tiempo" height={192} />
          ) : (
            <>
              <ChartContainer
                config={{
                  contacts: { label: "Contactos", color: TIMELINE_CONTACTS_COLOR },
                  opps: { label: "Oportunidades", color: TIMELINE_OPPS_COLOR },
                }}
                style={{ height: 300 }}
                className="w-full"
              >
                <BarChart
                  data={timelineData.chartData}
                  margin={{ left: 8, right: 8, top: 16, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <ChartTooltip content={<NonZeroTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                  <Bar
                    stackId="timeline"
                    dataKey="contacts"
                    name="Contactos"
                    fill={TIMELINE_CONTACTS_COLOR}
                    cursor="pointer"
                    onClick={(data: any) => {
                      const b = timelineData.buckets.find((x) => x.key === data.key)
                      if (b && b.contacts.length > 0) openContactsDrill(`Contactos · ${b.label}`, b.contacts)
                    }}
                  />
                  <Bar
                    stackId="timeline"
                    dataKey="opps"
                    name="Oportunidades"
                    fill={TIMELINE_OPPS_COLOR}
                    radius={[3, 3, 0, 0]}
                    cursor="pointer"
                    onClick={(data: any) => {
                      const b = timelineData.buckets.find((x) => x.key === data.key)
                      if (b && b.opps.length > 0) openDrill(`Oportunidades · ${b.label}`, b.opps)
                    }}
                  />
                </BarChart>
              </ChartContainer>
              <ChartHint>
                Barras apiladas: contactos y oportunidades creados por periodo · El selector solo cambia el eje X, no filtra · Haz clic en un segmento para ver los registros
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* ── Embudo de Ventas ───────────────────────── */}
      <SectionHeader title="Embudo de Ventas" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashboardCard>
          <ChartCardHeader title="Recorrido de la oportunidad" total={opportunities.length} />
          <ChartCardContent>
            {opportunities.length === 0 ? (
              <ChartEmpty message="Sin oportunidades para mostrar" height={192} />
            ) : (
              <>
                <div className="flex flex-col">
                  {/* Labels the right-hand column once, so the rows don't repeat "del total"
                      five times and can't be misread as the step-to-step conversion. */}
                  <div className="mb-1 pr-3 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    % del total
                  </div>
                  {funnelData.map((s, i) => {
                    const max = funnelData[0]?.count || 1
                    const prev = i > 0 ? funnelData[i - 1].count : 0
                    const conv = i > 0 && prev > 0 ? (s.count / prev) * 100 : null
                    const share = (s.count / max) * 100
                    const dropped = prev - s.count
                    return (
                      <div key={s.key}>
                        {i > 0 && conv !== null && conv <= 100 && (
                          <div className="flex items-center gap-2 py-1 pl-4 text-[11px]">
                            <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
                            <span className="font-semibold tabular-nums text-foreground/70">{conv.toFixed(1)}%</span>
                            <span className="text-muted-foreground">del paso anterior</span>
                            {dropped > 0 && (
                              <>
                                <span aria-hidden className="text-muted-foreground/40">·</span>
                                <span className="tabular-nums text-muted-foreground">
                                  −{dropped.toLocaleString("es-MX")} no avanzaron
                                </span>
                              </>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => openDrill(s.label, s.opps)}
                          aria-label={`${s.label}: ${s.count} oportunidades, ${share.toFixed(1)}% del total`}
                          className="group flex w-full flex-col gap-1.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        >
                          <span className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-2.5">
                            {/* The won stage is the number the reader came for, but its bar is
                                honestly tiny. Amber gives it the weight the bar can't. */}
                            <span
                              className={cn(
                                "min-w-[2.5ch] text-right text-[17px] font-semibold tabular-nums tracking-tight",
                                s.count === 0 && "text-muted-foreground/50",
                              )}
                              style={s.key === "won" && s.count > 0 ? { color: BRAND_AMBER } : undefined}
                            >
                              {s.count.toLocaleString("es-MX")}
                            </span>
                            <span className="truncate text-xs font-medium text-foreground">{s.label}</span>
                            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                              {share.toFixed(1)}%
                            </span>
                          </span>
                          {/* The meter is its own rail rather than a fill behind the text: at these
                              shares (a win can be 0.5%) a background fill would slice through the
                              numeral and read as a stray accent stripe. */}
                          <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            {/* Scaled, not resized — width is a layout property. The track clips the
                                square edge, so the radius never distorts under scaleX. */}
                            <span
                              aria-hidden
                              className="absolute inset-y-0 left-0 block w-full origin-left will-change-transform group-hover:brightness-110 motion-reduce:!transition-none"
                              style={{
                                background: s.color,
                                transform: `scaleX(${funnelReady ? s.count / max : 0})`,
                                transition: "transform 700ms cubic-bezier(0.16, 1, 0.3, 1)",
                                transitionDelay: `${i * 60}ms`,
                              }}
                            />
                          </span>
                        </button>
                      </div>
                    )
                  })}
                </div>
                <ChartHint>
                  {funnelData.some((s) => s.key === "contacted") && "Contactados = oportunidades con al menos un mensaje o llamada · "}
                  Citas = el contacto de la oportunidad tiene una cita · Haz clic en una etapa para ver las oportunidades
                </ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>

        <DashboardCard>
          <ChartCardHeader
            title="Histórico de oportunidades y conversión a cita"
            total={`${monthlyFunnel.months.length} meses`}
          />
          <ChartCardContent>
            {monthlyFunnel.chartData.length === 0 ? (
              <ChartEmpty message="Sin datos históricos" height={192} />
            ) : (
              <>
                <ChartContainer
                  config={{
                    leads: { label: "Oportunidades creadas", color: STRUCTURAL_NAVY },
                    rate: { label: "Tasa Oportunidad → Cita (%)", color: BRAND_AMBER },
                  }}
                  style={{ height: 280 }}
                  className="w-full"
                >
                  <ComposedChart
                    data={monthlyFunnel.chartData}
                    margin={{ left: 8, right: 8, top: 16, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <ChartTooltip content={<NonZeroTooltipContent />} />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                    <Bar
                      yAxisId="left"
                      dataKey="leads"
                      name="Oportunidades creadas"
                      fill={STRUCTURAL_NAVY}
                      radius={[3, 3, 0, 0]}
                      cursor="pointer"
                      onClick={(data: any) => {
                        const month = monthlyFunnel.months.find((m) => m.key === data.key)
                        if (month) openDrill(`Oportunidades de ${month.label}`, month.leads)
                      }}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="rate"
                      name="Tasa Oportunidad → Cita (%)"
                      stroke={BRAND_AMBER}
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: BRAND_AMBER }}
                    />
                  </ComposedChart>
                </ChartContainer>
                <ChartHint>
                  Barras: oportunidades creadas por mes · Línea: % de esas oportunidades que llegaron a cita · Haz clic en una barra para ver las oportunidades
                </ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>
      </div>

      {/* ── Ciclo de Decisión ──────────────────────── */}
      <SectionHeader title="Ciclo de Decisión" />
      <DecisionCycleTable
        opportunities={opportunities}
        contacts={lookupContacts}
        appointments={lookupAppointments}
        onOpenOpps={openDrill}
      />

      {/* ── Origen de Oportunidades ────────────────── */}
      <SectionHeader title="Origen de Oportunidades" />
      <DashboardCard>
        <ChartCardHeader title="Origen de oportunidades y conversión a cita" total={opportunities.length} />
        <ChartCardContent>
          {origenData.length === 0 ? (
            <ChartEmpty message="Sin datos de origen" height={192} />
          ) : (
            <>
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
                <div style={{ width: 180, height: 220, flexShrink: 0, position: "relative" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={origenData.map((o) => ({ name: o.platform, value: o.count }))}
                        cx="50%"
                        cy="50%"
                        innerRadius={56}
                        outerRadius={80}
                        dataKey="value"
                        nameKey="name"
                        startAngle={90}
                        endAngle={-270}
                        stroke="none"
                        paddingAngle={2}
                        activeIndex={hoveredOrigin}
                        activeShape={(props: any) => (
                          <Sector
                            cx={props.cx}
                            cy={props.cy}
                            innerRadius={props.innerRadius}
                            outerRadius={props.outerRadius + 5}
                            startAngle={props.startAngle}
                            endAngle={props.endAngle}
                            fill={props.fill}
                            stroke="none"
                          />
                        )}
                      >
                        {origenData.map((o) => (
                          <Cell key={o.platform} fill={o.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      textAlign: "center",
                      pointerEvents: "none",
                    }}
                  >
                    <div style={{ color: "hsl(var(--foreground))", fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
                      {opportunities.length.toLocaleString("es-MX")}
                    </div>
                    <div style={{ color: "hsl(var(--muted-foreground))", fontSize: 9, marginTop: 2 }}>OPORTUNIDADES</div>
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-[minmax(80px,1fr)_minmax(0,1fr)_64px_64px] gap-2 border-b border-border pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid-cols-[minmax(110px,160px)_1fr_90px_88px] sm:gap-3">
                    <span>Origen</span>
                    <span />
                    <span className="text-right">Oportunidades</span>
                    <span className="text-right">→ Citas</span>
                  </div>
                  {origenData.map((o, i) => {
                    const maxCount = origenData[0]?.count || 1
                    return (
                      <button
                        key={o.platform}
                        type="button"
                        className="grid w-full grid-cols-[minmax(80px,1fr)_minmax(0,1fr)_64px_64px] items-center gap-2 border-b border-border py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/20 sm:grid-cols-[minmax(110px,160px)_1fr_90px_88px] sm:gap-3"
                        onClick={() => openDrill(`Origen: ${o.platform}`, o.opps)}
                        onMouseEnter={() => setHoveredOrigin(i)}
                        onMouseLeave={() => setHoveredOrigin(undefined)}
                      >
                        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
                          <PlatformIcon platform={o.platform} />
                          <span className="truncate">{o.platform}</span>
                        </span>
                        <span className="h-2 overflow-hidden rounded bg-muted">
                          <span
                            className="block h-full rounded"
                            style={{ width: `${(o.count / maxCount) * 100}%`, background: o.color }}
                          />
                        </span>
                        <span className="text-right text-xs font-bold tabular-nums">
                          {o.count.toLocaleString("es-MX")}
                          <span className="ml-1 font-normal text-muted-foreground">· {o.pct.toFixed(1)}%</span>
                        </span>
                        <span
                          className="text-right text-xs font-bold tabular-nums"
                          style={{ color: o.citas.length > 0 ? o.color : undefined }}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (o.citas.length > 0) openDrill(`${o.platform} · Con cita`, o.citas)
                          }}
                        >
                          {o.citas.length > 0 ? (
                            <>
                              → {o.citas.length}
                              <span className="ml-1 font-normal text-muted-foreground">({o.citaRate.toFixed(0)}%)</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <ChartHint>
                → Citas = oportunidades de cada origen cuyo contacto tiene al menos una cita · Haz clic en una fila para ver las oportunidades
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* ── Salud del Pipeline ─────────────────────── */}
      <SectionHeader title="Salud del Pipeline" />
      <DashboardCard>
        <ChartCardHeader
          title="Estado actual del embudo por etapa"
          total={pipelineMatrix?.total ?? 0}
          actions={
            <div className="flex rounded-lg border border-border bg-muted p-0.5">
              {([
                { key: "asesor" as const, label: "Por asesor" },
                { key: "origen" as const, label: "Por origen" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    matrixBy === opt.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setMatrixBy(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          }
        />
        <ChartCardContent>
          {!pipelineMatrix ? (
            <ChartEmpty message="Sin oportunidades para mostrar" height={192} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Etapa del pipeline
                      </th>
                      {pipelineMatrix.cols.map((c) => (
                        <th
                          key={c}
                          title={c}
                          className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          {c.length > 12 ? c.slice(0, 12) + "…" : c}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelineMatrix.rows.map((row, ri) => (
                      <tr key={row.label} className="border-b border-border">
                        <td className="max-w-[220px] truncate px-3 py-1.5 font-medium text-foreground" title={row.label}>
                          <span
                            className="mr-2 inline-block h-1.5 w-1.5 rounded-sm align-middle"
                            style={{ background: row.dot }}
                          />
                          {row.label}
                        </td>
                        {pipelineMatrix.cells[ri].map((cellOpps, ci) => {
                          const v = cellOpps.length
                          const rgb =
                            row.kind === "lost" ? "239,68,68"
                            : row.kind === "won" ? "245,155,27"
                            : row.kind === "abandoned" ? "148,163,184"
                            : "59,130,246"
                          const max = row.kind === "lost" ? pipelineMatrix.lostMax : pipelineMatrix.liveMax
                          return (
                            <td key={ci} className="px-2 py-1 text-center">
                              {v === 0 ? (
                                <span className="text-muted-foreground/40">·</span>
                              ) : (
                                <button
                                  type="button"
                                  className="inline-block min-w-[30px] rounded-md px-2 py-0.5 font-semibold tabular-nums transition-[filter] hover:brightness-110"
                                  style={{ background: `rgba(${rgb},${(0.1 + Math.min(v / max, 1) * 0.4).toFixed(2)})` }}
                                  onClick={() =>
                                    openDrill(`${row.label} · ${pipelineMatrix.cols[ci]}`, cellOpps)
                                  }
                                >
                                  {v}
                                </button>
                              )}
                            </td>
                          )
                        })}
                        <td className="px-3 py-1.5 text-center font-bold tabular-nums">{row.opps.length}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="px-3 pt-2 text-left font-bold">Total general</td>
                      {pipelineMatrix.cols.map((c) => (
                        <td key={c} className="px-2 pt-2 text-center font-bold tabular-nums">
                          {(pipelineMatrix.colTotals.get(c) ?? 0).toLocaleString("es-MX")}
                        </td>
                      ))}
                      <td className="px-3 pt-2 text-center font-bold tabular-nums">
                        {pipelineMatrix.total.toLocaleString("es-MX")}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <ChartHint>
                Intensidad = volumen de oportunidades · azul = pipeline abierto · ámbar = ganado · rojo = perdido · Haz clic en una celda para ver las oportunidades
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* ── Citas ──────────────────────────────────── */}
      <SectionHeader title="Citas" />
      <DashboardCard>
        <ChartCardHeader title="Resultado de las citas" total={appointments.length} />
        <ChartCardContent>
          {apptOutcomeData.length === 0 ? (
            <ChartEmpty message="Sin citas para mostrar" height={96} />
          ) : (
            <>
              <div className="flex h-14 w-full gap-0.5 overflow-hidden rounded-lg">
                {apptOutcomeData.map((seg) => (
                  <button
                    key={seg.status}
                    type="button"
                    className="flex min-w-[84px] flex-col justify-center px-3 text-left text-white transition-[filter] hover:brightness-110"
                    style={{ flexGrow: seg.count, flexBasis: 0, background: seg.color }}
                    onClick={() =>
                      setApptDrill({
                        open: true,
                        title: `Citas · ${seg.label}`,
                        appointments: seg.appts,
                      })
                    }
                  >
                    <span className="text-base font-bold leading-none tabular-nums">{seg.count}</span>
                    <span className="mt-1 truncate text-[10px] font-medium opacity-90">
                      {seg.label} · {seg.pct.toFixed(0)}%
                    </span>
                  </button>
                ))}
              </div>
              <ChartHint>Ancho proporcional al volumen · Haz clic en un segmento para ver las citas</ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* ── Análisis de Pérdidas ───────────────────── */}
      <SectionHeader title="Análisis de Pérdidas" />
      <DashboardCard>
        <ChartCardHeader title="Principales razones de pérdida" total={lossGroupsData.totalLost} />
        <ChartCardContent>
          {lossGroupsData.groups.length === 0 ? (
            <ChartEmpty message="Sin oportunidades perdidas" height={120} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                {lossGroupsData.groups.map((g) => (
                  <button
                    key={g.reason}
                    type="button"
                    className="relative overflow-hidden rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/35"
                    onClick={() => openDrill(`Perdidos · ${g.reason}`, g.opps)}
                  >
                    <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: g.color }} />
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold tabular-nums tracking-tight" style={{ color: g.color }}>
                        {g.count.toLocaleString("es-MX")}
                      </span>
                      <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                        {g.pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-1.5 text-xs font-medium leading-snug text-foreground">{g.reason}</div>
                  </button>
                ))}
              </div>
              <ChartHint>% sobre el total de perdidos · Haz clic en una tarjeta para ver las oportunidades</ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* Appointment drill-down drawer */}
      <AppointmentDrillDrawer
        drill={apptDrill}
        onDrillChange={setApptDrill}
        contacts={lookupContacts}
      />

      {/* Drill-down drawer */}
      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={lookupContacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={lookupOpportunities}
        allPautas={pautas}
        appointments={lookupAppointments}
        messages={lookupMessages}
        locationId={locationId}
      />
    </DashboardShell>
  )
}
