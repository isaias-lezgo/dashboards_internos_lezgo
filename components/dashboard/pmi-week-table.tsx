"use client"

import { cn } from "@/lib/utils"
import { semaphore, type PmiCounts, type PmiIndicator, type PmiObjectives, type PmiSlice, type PmiWeek } from "@/lib/pmi"
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

// Una columna del período: una semana del mes o un mes del trimestre. Cada una
// trae su propio objetivo porque el del equipo cambia mes a mes (asesores
// activos × meta mensual).
export interface PmiPeriodColumn {
  key: string
  title: string
  subtitle?: string
  counts: PmiCounts
  objectives: PmiObjectives
  /** Empieza después de hoy: no ha ocurrido y se muestra como "—". */
  future: boolean
  drillLabel: string
}

export function PmiPeriodTable({
  title, columns, total, objective, objectiveLabel, columnObjective, columnObjectiveLabel, rule, onCell,
}: {
  title: string
  columns: PmiPeriodColumn[]
  total: PmiCounts
  /** Objetivo del período completo (mes o trimestre). */
  objective: PmiObjectives
  objectiveLabel: string
  /** Si todas las columnas comparten objetivo se muestra como columna propia; si no (equipo por mes), cada celda usa el suyo sin listarlo. */
  columnObjective?: PmiObjectives
  columnObjectiveLabel?: string
  rule: string
  onCell: (kind: PmiIndicator, ids: string[], label: string) => void
}) {
  return (
    <DashboardCard>
      <ChartCardHeader title={title} actions={<ScopePill label="Semáforo" tooltip={rule} />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Indicador</th>
                {columnObjective && <th className="py-1.5 px-2 text-right font-medium">{columnObjectiveLabel}</th>}
                {columns.map((col) => (
                  <th key={col.key} className={cn("py-1.5 px-2 text-right font-medium", col.future && "opacity-50")}>
                    <span className="block">{col.title}</span>
                    {col.subtitle && <span className="block font-normal normal-case">{col.subtitle}</span>}
                  </th>
                ))}
                <th className="py-1.5 px-2 text-right font-medium">Total</th>
                <th className="py-1.5 pl-2 text-right font-medium">{objectiveLabel}</th>
                <th className="py-1.5 pl-2 text-right font-medium">Avance</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const fmt = row.money ? fmtMxn : fmtInt
                const objPeriod = objective[row.key]
                const totalValue = cellValue(total, row)
                const drillKind: PmiIndicator = row.money ? row.drill : row.key
                return (
                  <tr key={row.key} className="border-t border-border/60">
                    <td className="py-1.5 pr-2 font-medium">{row.label}</td>
                    {columnObjective && <td className="py-1.5 px-2 text-right text-muted-foreground">{fmt(columnObjective[row.key])}</td>}
                    {columns.map((col) => {
                      const v = cellValue(col.counts, row)
                      const ids = col.counts.ids[drillKind]
                      if (col.future) {
                        return <td key={col.key} className="py-1 px-2 text-right text-muted-foreground/60">—</td>
                      }
                      return (
                        <td key={col.key} className="py-1 px-1 text-right">
                          <button
                            type="button"
                            disabled={ids.length === 0}
                            onClick={() => onCell(drillKind, ids, col.drillLabel)}
                            className={cn(
                              "w-full rounded px-1.5 py-1 text-right transition-colors",
                              toneClass(semaphore(v, col.objectives[row.key])),
                              ids.length > 0 ? "hover:ring-1 hover:ring-primary/40" : "cursor-default",
                            )}
                          >
                            {fmt(v)}
                          </button>
                        </td>
                      )
                    })}
                    <td className={cn("py-1 px-2 text-right font-semibold", toneClass(semaphore(totalValue, objPeriod)))}>{fmt(totalValue)}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">{fmt(objPeriod)}</td>
                    <td className="py-1.5 pl-2 text-right">{fmtPct(objPeriod > 0 ? totalValue / objPeriod : null)}</td>
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

export function PmiWeekTable({
  slice, weeks, today, onCell,
}: {
  slice: PmiSlice
  weeks: PmiWeek[]
  /** Día local de hoy: una semana que empieza después no ha ocurrido y se muestra como "—". */
  today: string
  onCell: (kind: PmiIndicator, ids: string[], weekLabel: string) => void
}) {
  return (
    <PmiPeriodTable
      title="Indicadores por semana"
      columns={weeks.map((w) => ({
        key: String(w.index),
        title: `Semana ${w.index + 1}`,
        subtitle: w.label,
        counts: slice.byWeek[w.index],
        objectives: slice.objectives.week,
        future: w.start > today,
        drillLabel: `Semana ${w.index + 1} (${w.label})`,
      }))}
      total={slice.total}
      objective={slice.objectives.month}
      objectiveLabel="Obj. mes"
      columnObjective={slice.objectives.week}
      columnObjectiveLabel="Obj. semana"
      rule="Contra el objetivo semanal (mes ÷ 4): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. Semanas de lunes a domingo; un pedazo de menos de 4 días se pega a la vecina."
      onCell={onCell}
    />
  )
}
