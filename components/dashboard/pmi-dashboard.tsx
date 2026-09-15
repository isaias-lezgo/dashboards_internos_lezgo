"use client"

import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import type { Appointment, Call, Contact, Message, Opportunity, Pauta, Task } from "@/lib/types"
import {
  buildPmiMonth, buildPmiYear, currentMonth, monthLabel, shiftMonth, semaphore, PMI_OBJECTIVES,
  type PmiIndicator, type PmiRankingRow, type PmiSlice, type PmiWeek,
} from "@/lib/pmi"
import {
  DashboardShell, DashboardCard, ChartCardHeader, ChartCardContent, ChartEmpty, ScopePill,
  NonZeroTooltipContent, CHART_TICK, CHART_GRID_STROKE, STRUCTURAL_NAVY, BRAND_AMBER,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { ConversionStrip, EstimatedNote, INDICATOR_LABELS, PmiSection, PmiTile, fmtInt, fmtMxn, fmtPct, toneClass } from "./pmi-ui"
import { PmiWeekTable } from "./pmi-week-table"
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

type PmiView = "month" | "year"
const TEAM = "__team__"

// Las reglas de cada indicador, en una sola copia para los ScopePill y el PDF.
export const PMI_RULES = {
  leads: "Todo contacto nuevo asignado al asesor en el período, venga de donde venga; abajo, cuántos son de pauta.",
  perfilamientos: "Primera vez que la oportunidad llegó a Cliente Calificado o una etapa posterior. Las perdidas cuentan por su última etapa.",
  citas: "Citas de calendario con estado 'showed' (el lead sí fue), por su fecha.",
  apartados: "Primera vez que la oportunidad llegó a Apartado o una etapa posterior. Un apartado que después se cae sigue contando en su mes.",
  cierres: "Primera vez que la oportunidad llegó a Proceso de Escritura, Siguiente Escritura, Negocio Ganado o Entregado.",
} as const

const COUNT_KEYS = ["leads", "perfilamientos", "citas", "apartados", "cierres"] as const

function RankingChart({
  title, rows, objective, onBar,
}: {
  title: string
  rows: PmiRankingRow[]
  objective: number
  onBar: (name: string) => void
}) {
  const data = rows.map((r) => ({ name: r.name, monto: r.monto, count: r.count }))
  return (
    <DashboardCard>
      <ChartCardHeader title={title}
        actions={<ScopePill label="Meta" tooltip={`La línea marca la meta mensual por asesor: ${fmtMxn(objective)}.`} />} />
      <ChartCardContent>
        {data.length === 0 ? (
          <ChartEmpty message="Sin asesores con actividad en el mes." />
        ) : (
          <ChartContainer config={{ monto: { label: "Monto" } }} className="h-[220px] w-full">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="name" tick={CHART_TICK} axisLine={false} tickLine={false} interval={0}
                tickFormatter={(v: string) => v.split(" ")[0]} />
              <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={64}
                tickFormatter={(v: number) => `$${(v / 1_000_000).toLocaleString("es-MX", { maximumFractionDigits: 1 })}M`} />
              <ReferenceLine y={objective} stroke={BRAND_AMBER} strokeDasharray="4 4"
                label={{ value: "META", position: "insideTopRight", fontSize: 10, fill: BRAND_AMBER }} />
              <ChartTooltip content={<NonZeroTooltipContent formatter={(v) => fmtMxn(Number(v))} />} />
              <Bar dataKey="monto" name="Monto" fill={STRUCTURAL_NAVY} radius={[4, 4, 0, 0]} cursor="pointer"
                onClick={(d: { name?: string }) => { if (d?.name) onBar(String(d.name)) }} />
            </BarChart>
          </ChartContainer>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}

function WeekTrend({ title, weeks, values, onPoint }: { title: string; weeks: PmiWeek[]; values: number[]; onPoint: (i: number) => void }) {
  const data = weeks.map((w, i) => ({ label: `Semana ${i + 1}`, value: values[i], index: i }))
  return (
    <DashboardCard>
      <ChartCardHeader title={title} />
      <ChartCardContent>
        <ChartContainer config={{ value: { label: title } }} className="h-[180px] w-full">
          <LineChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
            <XAxis dataKey="label" tick={CHART_TICK} axisLine={false} tickLine={false} />
            <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
            <ChartTooltip content={<NonZeroTooltipContent />} />
            <Line type="monotone" dataKey="value" name={title} stroke={STRUCTURAL_NAVY} strokeWidth={2}
              dot={{ r: 4, fill: STRUCTURAL_NAVY, strokeWidth: 0, cursor: "pointer" }}
              activeDot={{ r: 6, cursor: "pointer", onClick: (d: unknown) => { const idx = (d as { payload?: { index: number } })?.payload?.index; if (idx !== undefined) onPoint(idx) } }}>
              <LabelList dataKey="value" position="top" fontSize={11} className="fill-foreground" />
            </Line>
          </LineChart>
        </ChartContainer>
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

  const advisorNames = pmi.advisors.map((a) => a.name)
  const selected = advisor === TEAM ? null : pmi.advisors.find((a) => a.name === advisor) ?? null
  const slice: PmiSlice = selected ?? pmi.team

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
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
    if (selected) return buildPmiReport({ kind: "month-advisor", pmi, advisor: selected }, props.locationName)
    return buildPmiReport({ kind: "month-team", pmi }, props.locationName)
  }, [view, pmiYear, input, year, selected, pmi, props.locationName])

  const periodTitle = view === "year" ? String(year) : monthLabel(month)
  const scopeTitle = selected ? selected.name : "Equipo"
  const o = slice.objectives.month
  const t = slice.total
  const avance = (value: number, objective: number) => (objective > 0 ? value / objective : null)

  return (
    <DashboardShell>
      {/* Cabecera propia: el PMI es mensual por construcción, la barra global no aplica */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período anterior"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? -12 : -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold tabular-nums">{periodTitle}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período siguiente"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? 12 : 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["month", "year"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 font-medium transition-colors", view === v ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "month" ? "Mes" : "Año"}
            </button>
          ))}
        </div>
        {view === "month" && (
          <div className="flex flex-wrap gap-1 text-xs">
            {[TEAM, ...advisorNames].map((name) => (
              <button key={name} type="button" onClick={() => setAdvisor(name)}
                className={cn("rounded-full border px-3 py-1 font-medium transition-colors",
                  advisor === name ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                {name === TEAM ? "Equipo" : name}
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
          <PmiSection title={`${scopeTitle} · ${monthLabel(month)}`}
            hint={<ScopePill label="Objetivos" tooltip="Objetivos fijos por asesor y mes: leads 40, perfilamientos 16, citas 8, apartados 2 / $3M, cierres 2 / $3M. El equipo suma un objetivo por asesor con actividad en el mes." />}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <PmiTile label="Leads" value={fmtInt(t.leads)} sub={`${fmtInt(t.leadsPauta)} de pauta`}
                objective={fmtInt(o.leads)} avance={avance(t.leads, o.leads)}
                onClick={() => openDrill("leads", t.ids.leads, `Leads · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Perfilamientos" value={fmtInt(t.perfilamientos)}
                objective={fmtInt(o.perfilamientos)} avance={avance(t.perfilamientos, o.perfilamientos)}
                onClick={() => openDrill("perfilamientos", t.ids.perfilamientos, `Perfilamientos · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Citas efectivas" value={fmtInt(t.citas)}
                objective={fmtInt(o.citas)} avance={avance(t.citas, o.citas)}
                onClick={() => openDrill("citas", t.ids.citas, `Citas efectivas · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Apartados" value={fmtInt(t.apartados)} sub={fmtMxn(t.montoApartados)}
                objective={`${fmtInt(o.apartados)} · ${fmtMxn(o.montoApartados)}`} avance={avance(t.montoApartados, o.montoApartados)}
                onClick={() => openDrill("apartados", t.ids.apartados, `Apartados · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Cierres" value={fmtInt(t.cierres)} sub={fmtMxn(t.montoCierres)}
                objective={`${fmtInt(o.cierres)} · ${fmtMxn(o.montoCierres)}`} avance={avance(t.montoCierres, o.montoCierres)}
                onClick={() => openDrill("cierres", t.ids.cierres, `Cierres · ${scopeTitle}`, monthLabel(month))} />
            </div>
          </PmiSection>

          <PmiSection title="Conversiones"
            hint={<ScopePill label="Metas" tooltip="Metas de conversión del PMI: 40 % / 60 % / 75 % / 100 %. Sin denominador la conversión se muestra como —, no como 0 %." />}>
            <ConversionStrip conversions={slice.conversions} />
          </PmiSection>
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
            <DashboardCard>
              <ChartCardHeader title="Por asesor" total={pmi.activeAdvisors}
                actions={<ScopePill label="Activos" tooltip="Asesores con al menos un registro en el mes. 'Sin asignar' agrupa lo que no tiene asesor y no entra al ranking." />} />
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
                      {[...pmi.advisors, ...(pmi.unassigned ? [{ name: "Sin asignar", ...pmi.unassigned }] : [])].map((a) => {
                        const clickable = a.name !== "Sin asignar"
                        return (
                          <tr key={a.name}
                            className={cn("border-t border-border/60", clickable && "cursor-pointer hover:bg-primary/5")}
                            onClick={clickable ? () => setAdvisor(a.name) : undefined}>
                            <td className="py-1.5 pr-2 font-medium">{a.name}</td>
                            {COUNT_KEYS.map((k) => (
                              <td key={k} className="py-1 px-1 text-right">
                                <span className={cn("inline-block rounded px-1.5 py-0.5", toneClass(semaphore(a.total[k], a.objectives.month[k])))}>{fmtInt(a.total[k])}</span>
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
          )}

          {advisor === TEAM && (
            <div className="grid gap-4 lg:grid-cols-2">
              <RankingChart title="Ranking de apartados" rows={pmi.rankingApartados} objective={PMI_OBJECTIVES.montoApartados}
                onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a && a.total.apartados > 0) openDrill("apartados", a.total.ids.apartados, `Apartados · ${name}`, monthLabel(month)) }} />
              <RankingChart title="Ranking de cierres" rows={pmi.rankingCierres} objective={PMI_OBJECTIVES.montoCierres}
                onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a && a.total.cierres > 0) openDrill("cierres", a.total.ids.cierres, `Cierres · ${name}`, monthLabel(month)) }} />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <WeekTrend title="Perfilamientos por semana" weeks={pmi.weeks} values={slice.byWeek.map((c) => c.perfilamientos)}
              onPoint={(i) => { const ids = slice.byWeek[i].ids.perfilamientos; if (ids.length) openDrill("perfilamientos", ids, `Perfilamientos · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`) }} />
            <WeekTrend title="Citas efectivas por semana" weeks={pmi.weeks} values={slice.byWeek.map((c) => c.citas)}
              onPoint={(i) => { const ids = slice.byWeek[i].ids.citas; if (ids.length) openDrill("citas", ids, `Citas efectivas · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`) }} />
          </div>
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
  )
}

export { INDICATOR_LABELS }
