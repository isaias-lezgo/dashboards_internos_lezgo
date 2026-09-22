"use client"

import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import type { Appointment, Call, Contact, Message, Opportunity, Pauta, Task } from "@/lib/types"
import {
  buildPmiMonth, buildPmiQuarter, buildPmiYear, currentMonth, monthLabel, shiftMonth, quarterOf, quarterLabel, semaphore, PMI_OBJECTIVES,
  type PmiConversions, type PmiCounts, type PmiIndicator, type PmiObjectives, type PmiSlice,
} from "@/lib/pmi"
import {
  DashboardShell, DashboardCard, ChartCardHeader, ChartCardContent, ScopePill,
  NonZeroTooltipContent, CHART_TICK, CHART_GRID_STROKE, STRUCTURAL_NAVY,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { AdvisorAvatar, AvatarPaletteProvider, buildAvatarPalette, EstimatedNote, INDICATOR_LABELS, fmtInt, fmtMxn, fmtPct, toneClass } from "./pmi-ui"
import { PmiFunnel } from "./pmi-funnel"
import { PmiRankingChart } from "./pmi-ranking-chart"
import { PmiWeekTable, PmiPeriodTable } from "./pmi-week-table"
import { PmiAdvisorSheet } from "./pmi-advisor-sheet"
import { PmiYearView } from "./pmi-year-table"
import { ExportReportButton } from "./export-report-button"
import { buildPmiReport } from "@/lib/pmi-report"
import type { ReportInput } from "@/lib/report"

interface PmiDashboardProps {
  contacts: Contact[]
  opportunities: Opportunity[]
  appointments: Appointment[]
  pautas: Pauta[]
  tasks: Task[]
  calls: Call[]
  messages: Message[]
  locationId: string
  locationName?: string
}

type PmiView = "month" | "quarter" | "year"
const TEAM = "__team__"
const MONTHS_SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
const MONTHS_LONG = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
const monthName = (ym: string, long = false) => (long ? MONTHS_LONG : MONTHS_SHORT)[Number(ym.slice(5, 7)) - 1]

// Las reglas de cada indicador, en una sola copia para los ScopePill y el PDF.
export const PMI_RULES = {
  leads: "Todo contacto nuevo asignado al asesor en el período, venga de donde venga; abajo, cuántos son de pauta.",
  perfilamientos: "Primera vez que la oportunidad llegó a Cliente Calificado o una etapa posterior. Las perdidas cuentan por su última etapa.",
  citas: "Citas de calendario con estado 'showed' (el lead sí fue), por su fecha.",
  apartados: "Primera vez que la oportunidad llegó a Apartado o una etapa posterior. Un apartado que después se cae sigue contando en su mes.",
  cierres: "Primera vez que la oportunidad llegó a Proceso de Escritura, Siguiente Escritura, Negocio Ganado o Entregado.",
} as const

const COUNT_KEYS = ["leads", "perfilamientos", "citas", "apartados", "cierres"] as const

// Una línea por período (semanas del mes o meses del trimestre); el clic en
// cualquier parte de la columna del período abre sus registros (el chart
// resuelve el índice por `activePayload`, no hay que atinarle al punto).
function TrendLine({ title, labels, values, onPoint }: { title: string; labels: string[]; values: number[]; onPoint: (i: number) => void }) {
  const data = labels.map((label, i) => ({ label, value: values[i], index: i }))
  return (
    <DashboardCard>
      <ChartCardHeader title={title} />
      <ChartCardContent>
        <ChartContainer config={{ value: { label: title } }} className="h-[180px] w-full">
          <LineChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 0 }} style={{ cursor: "pointer" }}
            onClick={(state: { activePayload?: Array<{ payload?: { index: number } }> }) => {
              const idx = state?.activePayload?.[0]?.payload?.index
              if (idx !== undefined) onPoint(idx)
            }}>
            <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
            <XAxis dataKey="label" tick={CHART_TICK} axisLine={false} tickLine={false} />
            <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
            <ChartTooltip content={<NonZeroTooltipContent />} />
            <Line type="monotone" dataKey="value" name={title} stroke={STRUCTURAL_NAVY} strokeWidth={2}
              dot={{ r: 4, fill: STRUCTURAL_NAVY, strokeWidth: 0 }}
              activeDot={{ r: 6 }}>
              <LabelList dataKey="value" position="top" fontSize={11} className="fill-foreground" />
            </Line>
          </LineChart>
        </ChartContainer>
      </ChartCardContent>
    </DashboardCard>
  )
}

interface AdvisorRow { name: string; total: PmiCounts; objective: PmiObjectives; conversions: PmiConversions }

// La tabla "Por asesor" del mes y del trimestre: los cinco indicadores contra
// el objetivo del período, montos y conversiones. Clic en la fila = ese asesor.
function AdvisorTable({ rows, active, tooltip, onSelect }: { rows: AdvisorRow[]; active: number; tooltip: string; onSelect: (name: string) => void }) {
  return (
    <DashboardCard>
      <ChartCardHeader title="Por asesor" total={active} actions={<ScopePill label="Activos" tooltip={tooltip} />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                {COUNT_KEYS.map((k) => (
                  <th key={k} className="py-1.5 px-2 text-right font-medium">{INDICATOR_LABELS[k]}</th>
                ))}
                <th className="py-1.5 px-2 text-right font-medium">$ Apartados</th>
                <th className="py-1.5 px-2 text-right font-medium">$ Cierres</th>
                <th className="py-1.5 px-2 text-right font-medium">L→P</th>
                <th className="py-1.5 px-2 text-right font-medium">P→C</th>
                <th className="py-1.5 px-2 text-right font-medium">C→A</th>
                <th className="py-1.5 pl-2 text-right font-medium">A→Ci</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const clickable = a.name !== "Sin asignar"
                return (
                  <tr key={a.name}
                    className={cn("border-t border-border/60", clickable && "cursor-pointer hover:bg-primary/5")}
                    onClick={clickable ? () => onSelect(a.name) : undefined}>
                    <td className="py-1.5 pr-2 font-medium">
                      <span className="flex items-center gap-2">
                        {clickable && <AdvisorAvatar name={a.name} className="h-5 w-5 text-[9px]" />}
                        {a.name}
                      </span>
                    </td>
                    {COUNT_KEYS.map((k) => (
                      <td key={k} className="py-1 px-1 text-right">
                        <span className={cn("inline-block rounded px-1.5 py-0.5", toneClass(semaphore(a.total[k], a.objective[k])))}>{fmtInt(a.total[k])}</span>
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-right">{fmtMxn(a.total.montoApartados)}</td>
                    <td className="py-1.5 px-2 text-right">{fmtMxn(a.total.montoCierres)}</td>
                    <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.leadPerfil)}</td>
                    <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.perfilCita)}</td>
                    <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.citaApartado)}</td>
                    <td className="py-1.5 pl-2 text-right">{fmtPct(a.conversions.apartadoCierre)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </ChartCardContent>
    </DashboardCard>
  )
}

export function PmiDashboard(props: PmiDashboardProps) {
  const { contacts, opportunities, appointments, pautas, tasks, calls, messages, locationId } = props
  const [view, setView] = useState<PmiView>("month")
  const [month, setMonth] = useState(() => currentMonth())
  const [advisor, setAdvisor] = useState<string>(TEAM)
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)

  const input = useMemo(
    () => ({ contacts, opportunities, appointments, pautas }),
    [contacts, opportunities, appointments, pautas],
  )
  const pmi = useMemo(() => buildPmiMonth(input, month), [input, month])
  const year = Number(month.slice(0, 4))
  const pmiYear = useMemo(() => (view === "year" ? buildPmiYear(input, year) : null), [input, year, view])
  // El trimestre se deriva del mes en pantalla: las flechas mueven ±3 meses.
  const { year: qYear, q } = quarterOf(month)
  const pmiQuarter = useMemo(() => (view === "quarter" ? buildPmiQuarter(input, qYear, q) : null), [input, qYear, q, view])

  const advisorNames = (view === "quarter" && pmiQuarter ? pmiQuarter.advisors : pmi.advisors).map((a) => a.name)
  const selected = advisor === TEAM ? null : pmi.advisors.find((a) => a.name === advisor) ?? null
  const slice: PmiSlice = selected ?? pmi.team
  const selectedQ = advisor === TEAM || !pmiQuarter ? null : pmiQuarter.advisors.find((a) => a.name === advisor) ?? null
  const qSlice = selectedQ ?? pmiQuarter?.team ?? null

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  // Sobre TODOS los nombres del proyecto, no los del mes: así el color de un
  // asesor es el mismo en cualquier mes, trimestre o año.
  const avatarPalette = useMemo(
    () => buildAvatarPalette([...contacts, ...opportunities, ...appointments].flatMap((r) => (r.assignedTo?.trim() ? [r.assignedTo.trim()] : []))),
    [contacts, opportunities, appointments],
  )
  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])

  // Un solo camino de drill: por indicador, con los ids que el motor guardó.
  const openDrill = useCallback(
    (kind: PmiIndicator, ids: string[], title: string, subtitle?: string) => {
      if (kind === "leads") {
        const items = ids.map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      if (kind === "citas") {
        const wanted = new Set(ids)
        const byContact = new Set(appointments.filter((a) => wanted.has(a.id)).map((a) => a.contactId))
        const items = [...byContact].map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      const opps = ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => Boolean(o))
      setDrill({ open: true, title, subtitle, opportunities: opps })
    },
    [appointments, contactById, oppById],
  )

  const buildReport = useCallback((): ReportInput => {
    if (view === "year") return buildPmiReport({ kind: "year", year: pmiYear ?? buildPmiYear(input, year) }, props.locationName)
    if (view === "quarter") {
      const quarter = pmiQuarter ?? buildPmiQuarter(input, qYear, q)
      if (selectedQ) return buildPmiReport({ kind: "quarter-advisor", quarter, advisor: selectedQ }, props.locationName)
      return buildPmiReport({ kind: "quarter-team", quarter }, props.locationName)
    }
    if (selected) return buildPmiReport({ kind: "month-advisor", pmi, advisor: selected }, props.locationName)
    return buildPmiReport({ kind: "month-team", pmi }, props.locationName)
  }, [view, pmiYear, pmiQuarter, input, year, qYear, q, selected, selectedQ, pmi, props.locationName])

  const periodTitle = view === "year" ? String(year) : view === "quarter" ? quarterLabel(qYear, q) : monthLabel(month)
  const periodShift = view === "year" ? 12 : view === "quarter" ? 3 : 1
  const scopeTitle = view === "quarter" ? (selectedQ ? selectedQ.name : "Equipo") : selected ? selected.name : "Equipo"

  // Las mismas dos tendencias en los dos sitios donde viven: junto al embudo
  // del asesor, o abajo del todo en la vista de equipo.
  const weekLabels = pmi.weeks.map((_, i) => `Semana ${i + 1}`)
  const weekTrends = (
    <>
      <TrendLine title="Perfilamientos por semana" labels={weekLabels} values={slice.byWeek.map((c) => c.perfilamientos)}
        onPoint={(i) => { const ids = slice.byWeek[i].ids.perfilamientos; if (ids.length) openDrill("perfilamientos", ids, `Perfilamientos · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`) }} />
      <TrendLine title="Citas efectivas por semana" labels={weekLabels} values={slice.byWeek.map((c) => c.citas)}
        onPoint={(i) => { const ids = slice.byWeek[i].ids.citas; if (ids.length) openDrill("citas", ids, `Citas efectivas · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`) }} />
    </>
  )
  const monthTrends = pmiQuarter && qSlice ? (
    <>
      <TrendLine title="Perfilamientos por mes" labels={pmiQuarter.months.map((m) => monthName(m))} values={qSlice.byMonth.map((c) => c.perfilamientos)}
        onPoint={(i) => { const ids = qSlice.byMonth[i].ids.perfilamientos; if (ids.length) openDrill("perfilamientos", ids, `Perfilamientos · ${scopeTitle}`, monthLabel(pmiQuarter.months[i])) }} />
      <TrendLine title="Citas efectivas por mes" labels={pmiQuarter.months.map((m) => monthName(m))} values={qSlice.byMonth.map((c) => c.citas)}
        onPoint={(i) => { const ids = qSlice.byMonth[i].ids.citas; if (ids.length) openDrill("citas", ids, `Citas efectivas · ${scopeTitle}`, monthLabel(pmiQuarter.months[i])) }} />
    </>
  ) : null

  return (
    <AvatarPaletteProvider value={avatarPalette}>
    <DashboardShell>
      {/* Cabecera propia: el PMI es mensual por construcción, la barra global no aplica */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período anterior"
            onClick={() => setMonth((m) => shiftMonth(m, -periodShift))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold tabular-nums">{periodTitle}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período siguiente"
            onClick={() => setMonth((m) => shiftMonth(m, periodShift))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["month", "quarter", "year"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 font-medium transition-colors", view === v ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "month" ? "Mes" : v === "quarter" ? "Trimestre" : "Año"}
            </button>
          ))}
        </div>
        {view !== "year" && (
          <div className="flex flex-wrap gap-1 text-xs">
            {[TEAM, ...advisorNames].map((name) => (
              <button key={name} type="button" onClick={() => setAdvisor(name)}
                className={cn("rounded-full border px-3 py-1 font-medium transition-colors",
                  advisor === name ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                {name === TEAM ? "Equipo" : <span className="flex items-center gap-1.5"><AdvisorAvatar name={name} className="h-4 w-4 text-[8px]" />{name}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto">
          <ExportReportButton getInput={buildReport} />
        </div>
      </div>

      {view === "month" && (
        <>
          <EstimatedNote count={pmi.estimatedCount} />
          {/* Embudo a la izquierda; a la derecha lo que la hoja del Excel pone
              junto a él: los rankings del equipo, o las tendencias semanales del
              asesor cuando hay uno elegido. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <PmiFunnel total={slice.total} objective={slice.objectives.month} conversions={slice.conversions} scopeTitle={scopeTitle} advisorName={selected?.name}
              periodNote="El equipo suma un objetivo por asesor con actividad en el mes."
              onStage={(kind, ids) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, monthLabel(month))} />
            <div className="grid gap-4">
              {advisor === TEAM ? (
                <>
                  <PmiRankingChart title="Ranking de apartados" rows={pmi.rankingApartados} objective={PMI_OBJECTIVES.montoApartados} empty="Sin apartados en el mes."
                    onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a && a.total.apartados > 0) openDrill("apartados", a.total.ids.apartados, `Apartados · ${name}`, monthLabel(month)) }} />
                  <PmiRankingChart title="Ranking de cierres" rows={pmi.rankingCierres} objective={PMI_OBJECTIVES.montoCierres} empty="Sin cierres en el mes."
                    onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a && a.total.cierres > 0) openDrill("cierres", a.total.ids.cierres, `Cierres · ${name}`, monthLabel(month)) }} />
                </>
              ) : weekTrends}
            </div>
          </div>
          {selected && (
            <PmiAdvisorSheet slice={selected} weeks={pmi.weeks} days={pmi.days} today={pmi.today}
              onCell={(kind, ids, dayLabel) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${selected.name}`, dayLabel)} />
          )}

          <PmiWeekTable
            slice={slice}
            weeks={pmi.weeks}
            today={pmi.today}
            onCell={(kind, ids, weekLabel) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, `${weekLabel} · ${monthLabel(month)}`)}
          />
          {advisor === TEAM && (
            <AdvisorTable
              rows={[...pmi.advisors, ...(pmi.unassigned ? [{ name: "Sin asignar", ...pmi.unassigned }] : [])].map((a) => ({ name: a.name, total: a.total, objective: a.objectives.month, conversions: a.conversions }))}
              active={pmi.activeAdvisors}
              tooltip="Asesores con al menos un registro en el mes. 'Sin asignar' agrupa lo que no tiene asesor y no entra al ranking."
              onSelect={setAdvisor} />
          )}

          {advisor === TEAM && <div className="grid gap-4 lg:grid-cols-2">{weekTrends}</div>}
        </>
      )}

      {view === "quarter" && pmiQuarter && qSlice && (
        <>
          <EstimatedNote count={pmiQuarter.estimatedCount} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <PmiFunnel total={qSlice.total} objective={qSlice.objectives.quarter} conversions={qSlice.conversions} scopeTitle={scopeTitle} advisorName={selectedQ?.name}
              periodNote="El objetivo del trimestre es el mensual por cada mes con actividad; el equipo suma un objetivo por asesor activo en cada mes."
              onStage={(kind, ids) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, quarterLabel(qYear, q))} />
            <div className="grid gap-4">
              {advisor === TEAM ? (
                <>
                  <PmiRankingChart title="Ranking de apartados" rows={pmiQuarter.rankingApartados} objective={null} empty="Sin apartados en el trimestre."
                    hint={<ScopePill label="Meta" tooltip={`${fmtMxn(PMI_OBJECTIVES.montoApartados)} por asesor por cada mes del trimestre con actividad. El color de la barra es el semáforo contra esa meta.`} />}
                    onBar={(name) => { const a = pmiQuarter.advisors.find((x) => x.name === name); if (a && a.total.apartados > 0) openDrill("apartados", a.total.ids.apartados, `Apartados · ${name}`, quarterLabel(qYear, q)) }} />
                  <PmiRankingChart title="Ranking de cierres" rows={pmiQuarter.rankingCierres} objective={null} empty="Sin cierres en el trimestre."
                    hint={<ScopePill label="Meta" tooltip={`${fmtMxn(PMI_OBJECTIVES.montoCierres)} por asesor por cada mes del trimestre con actividad. El color de la barra es el semáforo contra esa meta.`} />}
                    onBar={(name) => { const a = pmiQuarter.advisors.find((x) => x.name === name); if (a && a.total.cierres > 0) openDrill("cierres", a.total.ids.cierres, `Cierres · ${name}`, quarterLabel(qYear, q)) }} />
                </>
              ) : monthTrends}
            </div>
          </div>

          <PmiPeriodTable
            title="Indicadores por mes"
            columns={pmiQuarter.months.map((m, i) => ({
              key: m,
              title: monthName(m, true),
              counts: qSlice.byMonth[i],
              objectives: qSlice.objectives.byMonth[i],
              future: `${m}-01` > pmiQuarter.today,
              drillLabel: monthLabel(m),
            }))}
            total={qSlice.total}
            objective={qSlice.objectives.quarter}
            objectiveLabel="Obj. trimestre"
            columnObjective={selectedQ ? PMI_OBJECTIVES : undefined}
            columnObjectiveLabel="Obj. mes"
            rule={selectedQ
              ? "Cada mes contra el objetivo mensual del asesor: verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. El objetivo del trimestre es el mensual por cada mes con actividad."
              : "Cada mes contra su propio objetivo (asesores activos ese mes × meta mensual): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. El objetivo del trimestre es la suma de los tres."}
            onCell={(kind, ids, label) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, label)}
          />
          {advisor === TEAM && (
            <AdvisorTable
              rows={[...pmiQuarter.advisors, ...(pmiQuarter.unassigned ? [{ name: "Sin asignar", ...pmiQuarter.unassigned }] : [])].map((a) => ({ name: a.name, total: a.total, objective: a.objectives.quarter, conversions: a.conversions }))}
              active={pmiQuarter.activeAdvisors}
              tooltip="Asesores con al menos un registro en el trimestre. Su objetivo es el mensual por cada mes con actividad. 'Sin asignar' agrupa lo que no tiene asesor y no entra al ranking."
              onSelect={setAdvisor} />
          )}
          {advisor === TEAM && <div className="grid gap-4 lg:grid-cols-2">{monthTrends}</div>}
        </>
      )}

      {view === "year" && pmiYear && (
        <>
          <EstimatedNote count={pmiYear.estimatedCount} />
          <PmiYearView year={pmiYear} onCell={(kind, ids, label) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${label}`)} />
        </>
      )}

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={opportunities}
        allPautas={pautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardShell>
    </AvatarPaletteProvider>
  )
}

export { INDICATOR_LABELS }
