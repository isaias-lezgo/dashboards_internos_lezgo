"use client"

import { cn } from "@/lib/utils"
import { semaphore, type PmiCounts, type PmiIndicator, type PmiSlice, type PmiWeek } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, fmtInt, fmtMxn, fmtPct, toneClass } from "./pmi-ui"

// Filas de la tabla: los cinco conteos y los dos montos. Los montos no son
// indicadores con ids propios: abren el drill de su conteo.
type Row =
  | { key: PmiIndicator; label: string; money?: false }
  | { key: "montoApartados" | "montoCierres"; label: string; money: true; drill: PmiIndicator }

const ROWS: Row[] = [
  { key: "leads", label: INDICATOR_LABELS.leads },
  { key: "perfilamientos", label: INDICATOR_LABELS.perfilamientos },
  { key: "citas", label: INDICATOR_LABELS.citas },
  { key: "apartados", label: INDICATOR_LABELS.apartados },
  { key: "montoApartados", label: "Monto de apartados", money: true, drill: "apartados" },
  { key: "cierres", label: INDICATOR_LABELS.cierres },
  { key: "montoCierres", label: "Monto de cierres", money: true, drill: "cierres" },
]

function cellValue(c: PmiCounts, row: Row): number {
  return c[row.key]
}

export function PmiWeekTable({
  slice, weeks, today, onCell,
}: {
  slice: PmiSlice
  weeks: PmiWeek[]
  /** Día local de hoy: una semana que empieza después no ha ocurrido y se muestra como "—". */
  today: string
  onCell: (kind: PmiIndicator, ids: string[], weekLabel: string) => void
}) {
  const isFuture = (w: PmiWeek) => w.start > today
  return (
    <DashboardCard>
      <ChartCardHeader
        title="Indicadores por semana"
        actions={<ScopePill label="Semáforo" tooltip="Contra el objetivo semanal (mes ÷ 4): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. Semanas de lunes a domingo; un pedazo de menos de 4 días se pega a la vecina." />}
      />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Indicador</th>
                <th className="py-1.5 px-2 text-right font-medium">Obj. semana</th>
                {weeks.map((w) => (
                  <th key={w.index} className={cn("py-1.5 px-2 text-right font-medium", isFuture(w) && "opacity-50")}>
                    <span className="block">Semana {w.index + 1}</span>
                    <span className="block font-normal normal-case">{w.label}</span>
                  </th>
                ))}
                <th className="py-1.5 px-2 text-right font-medium">Total</th>
                <th className="py-1.5 pl-2 text-right font-medium">Obj. mes</th>
                <th className="py-1.5 pl-2 text-right font-medium">Avance</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const fmt = row.money ? fmtMxn : fmtInt
                const objWeek = slice.objectives.week[row.key]
                const objMonth = slice.objectives.month[row.key]
                const total = cellValue(slice.total, row)
                const drillKind: PmiIndicator = row.money ? row.drill : row.key
                return (
                  <tr key={row.key} className="border-t border-border/60">
                    <td className="py-1.5 pr-2 font-medium">{row.label}</td>
                    <td className="py-1.5 px-2 text-right text-muted-foreground">{fmt(objWeek)}</td>
                    {weeks.map((w) => {
                      const c = slice.byWeek[w.index]
                      const v = cellValue(c, row)
                      const ids = c.ids[drillKind]
                      if (isFuture(w)) {
                        return <td key={w.index} className="py-1 px-2 text-right text-muted-foreground/60">—</td>
                      }
                      return (
                        <td key={w.index} className="py-1 px-1 text-right">
                          <button
                            type="button"
                            disabled={ids.length === 0}
                            onClick={() => onCell(drillKind, ids, `Semana ${w.index + 1} (${w.label})`)}
                            className={cn(
                              "w-full rounded px-1.5 py-1 text-right transition-colors",
                              toneClass(semaphore(v, objWeek)),
                              ids.length > 0 ? "hover:ring-1 hover:ring-primary/40" : "cursor-default",
                            )}
                          >
                            {fmt(v)}
                          </button>
                        </td>
                      )
                    })}
                    <td className={cn("py-1 px-2 text-right font-semibold", toneClass(semaphore(total, objMonth)))}>{fmt(total)}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">{fmt(objMonth)}</td>
                    <td className="py-1.5 pl-2 text-right">{fmtPct(objMonth > 0 ? total / objMonth : null)}</td>
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
