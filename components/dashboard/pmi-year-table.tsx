"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { PMI_OBJECTIVES, type PmiCounts, type PmiIndicator, type PmiYear, type PmiYearRankingRow } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, AdvisorAvatar, fmtInt, fmtMxn, fmtPct } from "./pmi-ui"
import { PmiRankingChart } from "./pmi-ranking-chart"
import { MonthlyMoneyLine, QuarterRankings } from "./pmi-year-charts"

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
type Metric = PmiIndicator | "montoApartados" | "montoCierres"
interface MetricDef { key: Metric; label: string; money: boolean; drill: PmiIndicator }
const METRICS: MetricDef[] = [
  { key: "leads", label: INDICATOR_LABELS.leads, money: false, drill: "leads" },
  { key: "perfilamientos", label: INDICATOR_LABELS.perfilamientos, money: false, drill: "perfilamientos" },
  { key: "citas", label: INDICATOR_LABELS.citas, money: false, drill: "citas" },
  { key: "apartados", label: INDICATOR_LABELS.apartados, money: false, drill: "apartados" },
  { key: "montoApartados", label: "$ Apartados", money: true, drill: "apartados" },
  { key: "cierres", label: INDICATOR_LABELS.cierres, money: false, drill: "cierres" },
  { key: "montoCierres", label: "$ Cierres", money: true, drill: "cierres" },
]

function Cell({ c, metric, onClick, strong }: { c: PmiCounts; metric: MetricDef; onClick: () => void; strong?: boolean }) {
  const v = c[metric.key]
  const ids = c.ids[metric.drill]
  return (
    <td className="px-0.5 py-0.5 text-right">
      <button type="button" disabled={ids.length === 0} onClick={onClick}
        className={cn("w-full rounded px-1 py-0.5 text-right", strong && "font-semibold",
          ids.length > 0 ? "hover:bg-primary/10" : "cursor-default text-muted-foreground")}>
        {metric.money ? fmtMxn(v) : fmtInt(v)}
      </button>
    </td>
  )
}

function YearRanking({ title, rows, objective }: { title: string; rows: PmiYearRankingRow[]; objective: number }) {
  return (
    <DashboardCard>
      <ChartCardHeader title={title}
        actions={<ScopePill label="Meta anual" tooltip={`${fmtMxn(objective)} por asesor por cada mes con actividad. "$ para llegar" es lo que falta contra esa meta.`} />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                <th className="py-1.5 px-2 text-right font-medium">Total</th>
                <th className="py-1.5 px-2 text-right font-medium">#</th>
                <th className="py-1.5 px-2 text-right font-medium">Meses activo</th>
                <th className="py-1.5 px-2 text-right font-medium">Promedio</th>
                <th className="py-1.5 px-2 text-right font-medium">Avance</th>
                <th className="py-1.5 pl-2 text-right font-medium">$ para llegar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-border/60">
                  <td className="py-1.5 pr-2 font-medium"><span className="flex items-center gap-2"><AdvisorAvatar name={r.name} className="h-5 w-5 text-[9px]" />{r.name}</span></td>
                  <td className="py-1.5 px-2 text-right">{fmtMxn(r.monto)}</td>
                  <td className="py-1.5 px-2 text-right">{fmtInt(r.count)}</td>
                  <td className="py-1.5 px-2 text-right">{r.mesesActivo}</td>
                  <td className="py-1.5 px-2 text-right">{r.promedio === null ? "—" : fmtMxn(r.promedio)}</td>
                  <td className="py-1.5 px-2 text-right">{fmtPct(r.avance)}</td>
                  <td className="py-1.5 pl-2 text-right">{fmtMxn(r.paraLlegar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCardContent>
    </DashboardCard>
  )
}

export function PmiYearView({ year, onCell }: { year: PmiYear; onCell: (kind: PmiIndicator, ids: string[], label: string) => void }) {
  // El clic en la barra de un asesor abre sus registros del período de esa gráfica.
  const drillAdvisor = (kind: "apartados" | "cierres", name: string, ids: string[], label: string) => { if (ids.length) onCell(kind, ids, `${name} · ${label}`) }
  const [metricKey, setMetricKey] = useState<Metric>("apartados")
  const metric = METRICS.find((m) => m.key === metricKey)!
  // Un mes que empieza después de hoy no ha ocurrido: "—", no 0.
  const futureMonth = (i: number) => `${year.year}-${String(i + 1).padStart(2, "0")}-01` > year.today
  const futureCell = (key: number) => <td key={key} className="px-1 py-0.5 text-right text-muted-foreground/60">—</td>
  const fmtAvg = (v: number) => (metric.money ? fmtMxn(v) : v.toLocaleString("es-MX", { maximumFractionDigits: 1 }))
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <MonthlyMoneyLine year={year} kind="apartados" onPoint={onCell} />
        <MonthlyMoneyLine year={year} kind="cierres" onPoint={onCell} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <PmiRankingChart title={`Ranking de apartados ${year.year}`} rows={year.rankingApartados} objective={null} empty="Sin apartados en el año."
          hint={<ScopePill label="Meta anual" tooltip={`${fmtMxn(PMI_OBJECTIVES.montoApartados)} por asesor por cada mes con actividad. El color de la barra es el semáforo contra esa meta; el detalle está en la tabla de abajo.`} />}
          onBar={(name) => { const a = year.advisors.find((x) => x.name === name); if (a) drillAdvisor("apartados", name, a.total.ids.apartados, String(year.year)) }} />
        <PmiRankingChart title={`Ranking de cierres ${year.year}`} rows={year.rankingCierres} objective={null} empty="Sin cierres en el año."
          hint={<ScopePill label="Meta anual" tooltip={`${fmtMxn(PMI_OBJECTIVES.montoCierres)} por asesor por cada mes con actividad. El color de la barra es el semáforo contra esa meta; el detalle está en la tabla de abajo.`} />}
          onBar={(name) => { const a = year.advisors.find((x) => x.name === name); if (a) drillAdvisor("cierres", name, a.total.ids.cierres, String(year.year)) }} />
      </div>
      <QuarterRankings year={year} kind="apartados"
        onBar={(name, q) => { const a = year.advisors.find((x) => x.name === name); if (a) drillAdvisor("apartados", name, a.byQuarter[q.index].ids.apartados, `${q.label} ${year.year}`) }} />
      <QuarterRankings year={year} kind="cierres"
        onBar={(name, q) => { const a = year.advisors.find((x) => x.name === name); if (a) drillAdvisor("cierres", name, a.byQuarter[q.index].ids.cierres, `${q.label} ${year.year}`) }} />
      <DashboardCard>
        <ChartCardHeader title={`Asesor × mes · ${year.year}`}
          actions={
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value as Metric)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs" aria-label="Indicador">
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          } />
        <ChartCardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs tabular-nums">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                  {MONTHS.map((m, i) => (
                    <th key={m} className={cn("py-1.5 px-1 text-right font-medium", i % 3 === 0 && "border-l border-border/60")}>{m}</th>
                  ))}
                  {["T1", "T2", "T3", "T4"].map((q) => <th key={q} className="border-l border-border/60 py-1.5 px-1 text-right font-medium">{q}</th>)}
                  <th className="border-l border-border/60 py-1.5 px-1 text-right font-medium">Total</th>
                  <th className="py-1.5 px-1 text-right font-medium">Meses</th>
                  <th className="py-1.5 pl-1 text-right font-medium">Prom.</th>
                </tr>
              </thead>
              <tbody>
                {year.advisors.map((a) => (
                  <tr key={a.name} className="border-t border-border/60">
                    <td className="py-1 pr-2 font-medium"><span className="flex items-center gap-2"><AdvisorAvatar name={a.name} className="h-5 w-5 text-[9px]" />{a.name}</span></td>
                    {a.byMonth.map((c, i) => futureMonth(i) ? futureCell(i) : <Cell key={i} c={c} metric={metric} onClick={() => onCell(metric.drill, c.ids[metric.drill], `${a.name} · ${MONTHS[i]} ${year.year}`)} />)}
                    {a.byQuarter.map((c, q) => <Cell key={`q${q}`} c={c} metric={metric} strong onClick={() => onCell(metric.drill, c.ids[metric.drill], `${a.name} · T${q + 1} ${year.year}`)} />)}
                    <Cell c={a.total} metric={metric} strong onClick={() => onCell(metric.drill, a.total.ids[metric.drill], `${a.name} · ${year.year}`)} />
                    <td className="py-1 px-1 text-right">{a.mesesActivo}</td>
                    <td className="py-1 pl-1 text-right">{a.promedio ? fmtAvg(a.promedio[metric.key]) : "—"}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border font-semibold">
                  <td className="py-1 pr-2">Equipo</td>
                  {year.team.byMonth.map((c, i) => futureMonth(i) ? futureCell(i) : <Cell key={i} c={c} metric={metric} strong onClick={() => onCell(metric.drill, c.ids[metric.drill], `Equipo · ${MONTHS[i]} ${year.year}`)} />)}
                  {year.team.byQuarter.map((c, q) => <Cell key={`q${q}`} c={c} metric={metric} strong onClick={() => onCell(metric.drill, c.ids[metric.drill], `Equipo · T${q + 1} ${year.year}`)} />)}
                  <Cell c={year.team.total} metric={metric} strong onClick={() => onCell(metric.drill, year.team.total.ids[metric.drill], `Equipo · ${year.year}`)} />
                  <td /><td />
                </tr>
                <tr className="text-muted-foreground">
                  <td className="py-1 pr-2">% meta</td>
                  {year.team.pctMeta.map((p, i) => <td key={i} className="px-1 py-1 text-right">{futureMonth(i) ? "—" : fmtPct(p ? p[metric.key] : null)}</td>)}
                  <td colSpan={7} />
                </tr>
              </tbody>
            </table>
          </div>
        </ChartCardContent>
      </DashboardCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <YearRanking title={`Ranking de apartados ${year.year}`} rows={year.rankingApartados} objective={PMI_OBJECTIVES.montoApartados} />
        <YearRanking title={`Ranking de cierres ${year.year}`} rows={year.rankingCierres} objective={PMI_OBJECTIVES.montoCierres} />
      </div>
      <DashboardCard>
        <ChartCardHeader title="Ticket promedio"
          actions={<ScopePill label="Cierres" tooltip="Monto cerrado entre número de cierres del año, por asesor." />} />
        <ChartCardContent>
          <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
            {year.advisors.map((a) => (
              <li key={a.name} className="flex justify-between gap-2 rounded border border-border px-3 py-2">
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 tabular-nums">{a.ticketPromedio === null ? "—" : fmtMxn(a.ticketPromedio)}</span>
              </li>
            ))}
          </ul>
        </ChartCardContent>
      </DashboardCard>
    </>
  )
}
