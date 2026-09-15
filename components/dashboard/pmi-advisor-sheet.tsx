"use client"

import { Fragment } from "react"
import { cn } from "@/lib/utils"
import { semaphore, type PmiIndicator, type PmiSlice, type PmiWeek } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, fmtInt, toneClass } from "./pmi-ui"

const WEEKDAY = ["D", "L", "M", "M", "J", "V", "S"]
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

function weekdayLetter(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

function dayLabel(day: string): string {
  return `${Number(day.slice(8))} de ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]}`
}

const ROWS: PmiIndicator[] = ["leads", "perfilamientos", "citas", "apartados", "cierres"]

// La ficha del asesor: indicadores × días agrupados por semana, teñida por el
// semáforo DIARIO (objetivo mes ÷ 28), con el total por semana. Es la tabla
// que el asesor llenaba a mano.
export function PmiAdvisorSheet({
  slice, weeks, days, onCell,
}: {
  slice: PmiSlice
  weeks: PmiWeek[]
  days: string[]
  onCell: (kind: PmiIndicator, ids: string[], dayLabel: string) => void
}) {
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  return (
    <DashboardCard>
      <ChartCardHeader title="Día a día"
        actions={<ScopePill label="Semáforo diario" tooltip="Contra el objetivo diario (semanal ÷ 7): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. El total de cada semana (Σ) se compara con el objetivo semanal." />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="text-[11px] tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 bg-card py-1 pr-2 text-left font-medium">Indicador</th>
                {weeks.map((w) => (
                  <th key={w.index} colSpan={w.days.length + 1} className="border-l border-border/60 px-1 py-1 text-center font-medium">
                    Semana {w.index + 1} · {w.label}
                  </th>
                ))}
              </tr>
              <tr className="text-[10px] text-muted-foreground">
                <th className="sticky left-0 bg-card" />
                {weeks.map((w) => (
                  <Fragment key={w.index}>
                    {w.days.map((d, i) => (
                      <th key={d} className={cn("w-7 px-0.5 py-0.5 text-center font-normal", i === 0 && "border-l border-border/60")}>
                        <span className="block">{Number(d.slice(8))}</span>
                        <span className="block opacity-70">{weekdayLetter(d)}</span>
                      </th>
                    ))}
                    <th className="px-1 py-0.5 text-center font-medium">Σ</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((kind) => {
                const objDay = slice.objectives.day[kind]
                const objWeek = slice.objectives.week[kind]
                return (
                  <tr key={kind} className="border-t border-border/60">
                    <td className="sticky left-0 bg-card py-0.5 pr-2 font-medium">{INDICATOR_LABELS[kind]}</td>
                    {weeks.map((w) => (
                      <Fragment key={w.index}>
                        {w.days.map((d, i) => {
                          const c = slice.byDay[dayIndex.get(d)!]
                          const v = c[kind]
                          const ids = c.ids[kind]
                          return (
                            <td key={d} className={cn("px-0.5 py-0.5", i === 0 && "border-l border-border/60")}>
                              <button type="button" disabled={ids.length === 0}
                                onClick={() => onCell(kind, ids, dayLabel(d))}
                                className={cn("h-6 w-7 rounded text-center", toneClass(semaphore(v, objDay)),
                                  ids.length > 0 ? "hover:ring-1 hover:ring-primary/40" : "cursor-default opacity-60")}>
                                {v}
                              </button>
                            </td>
                          )
                        })}
                        <td className={cn("px-1 py-0.5 text-center font-semibold", toneClass(semaphore(slice.byWeek[w.index][kind], objWeek)))}>
                          {fmtInt(slice.byWeek[w.index][kind])}
                        </td>
                      </Fragment>
                    ))}
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
