"use client"

import { CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { PMI_OBJECTIVES, type PmiIndicator, type PmiQuarter, type PmiYear } from "@/lib/pmi"
import {
  DashboardCard, ChartCardHeader, ChartCardContent, ChartEmpty, ScopePill,
  NonZeroTooltipContent, CHART_TICK, CHART_GRID_STROKE, STRUCTURAL_NAVY,
} from "./dashboard-ui"
import { PmiRankingChart } from "./pmi-ranking-chart"
import { fmtMxn, fmtMxnCompact, fmtPct } from "./pmi-ui"

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

type MoneyKind = "apartados" | "cierres"
const MONEY_KEY: Record<MoneyKind, "montoApartados" | "montoCierres"> = { apartados: "montoApartados", cierres: "montoCierres" }
const MONEY_TITLE: Record<MoneyKind, string> = { apartados: "Apartados por mes", cierres: "Cierres por mes" }

// Un mes que empieza después de hoy no ha ocurrido: no lleva punto, no lleva
// cero. La misma regla que la tabla anual.
function futureMonth(year: PmiYear, i: number): boolean {
  return `${year.year}-${String(i + 1).padStart(2, "0")}-01` > year.today
}

// El clic va en el chart y no en el punto: Recharts resuelve el mes por la
// columna bajo el cursor (`activePayload`), así que atinarle a un punto de 4px
// deja de ser requisito. El drawer abre con los ids que el motor guardó.
export function MonthlyMoneyLine({ year, kind, onPoint }: { year: PmiYear; kind: MoneyKind; onPoint: (kind: PmiIndicator, ids: string[], label: string) => void }) {
  const key = MONEY_KEY[kind]
  const data = year.team.byMonth.map((c, i) => ({
    label: MONTHS[i],
    index: i,
    value: futureMonth(year, i) ? null : c[key],
  }))
  const occurred = data.filter((d) => d.value !== null)
  return (
    <DashboardCard>
      <ChartCardHeader title={`${MONEY_TITLE[kind]} · ${year.year}`}
        actions={<ScopePill label="Equipo" tooltip={`Monto ${kind === "apartados" ? "apartado" : "cerrado"} por el equipo en cada mes, según el campo "${kind === "apartados" ? "Fecha de apartado" : "Fecha de cierre"}" de cada oportunidad; sin fecha no cuenta. Los meses que no han ocurrido no llevan punto. Clic en un mes para ver sus oportunidades.`} />} />
      <ChartCardContent>
        {occurred.length === 0 ? (
          <ChartEmpty message="El año no ha empezado." />
        ) : (
          <ChartContainer config={{ value: { label: "Monto" } }} className="h-[200px] w-full">
            <LineChart data={data} margin={{ top: 20, right: 16, left: 0, bottom: 0 }} style={{ cursor: "pointer" }}
              onClick={(state: { activePayload?: Array<{ payload?: { index: number } }> }) => {
                const idx = state?.activePayload?.[0]?.payload?.index
                if (idx === undefined || futureMonth(year, idx)) return
                const ids = year.team.byMonth[idx].ids[kind]
                if (ids.length) onPoint(kind, ids, `Equipo · ${MONTHS[idx]} ${year.year}`)
              }}>
              <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="label" tick={CHART_TICK} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={52} tickFormatter={(v: number) => fmtMxnCompact(v)} />
              <ChartTooltip content={<NonZeroTooltipContent formatter={(v) => fmtMxn(Number(v))} />} />
              <Line type="monotone" dataKey="value" name="Monto" stroke={STRUCTURAL_NAVY} strokeWidth={2} connectNulls={false}
                isAnimationActive={false}
                dot={{ r: 4, fill: STRUCTURAL_NAVY, strokeWidth: 0 }}
                activeDot={{ r: 6 }}>
                <LabelList dataKey="value" position="top" fontSize={10} className="fill-foreground"
                  formatter={(v: number | null) => (v === null || v === 0 ? "" : fmtMxnCompact(v))} />
              </Line>
            </LineChart>
          </ChartContainer>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}

function QuarterFooter({ q, kind }: { q: PmiQuarter; kind: MoneyKind }) {
  const monto = q.team[MONEY_KEY[kind]]
  const objective = q.objectives?.[MONEY_KEY[kind]] ?? null
  const avance = objective !== null && objective > 0 ? monto / objective : null
  return (
    <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border/60 pt-2 text-xs">
      <span className="font-semibold tabular-nums">{fmtMxn(monto)}</span>
      <span className="text-muted-foreground tabular-nums">{avance === null ? "sin meta" : `${fmtPct(avance)} de la meta`}</span>
    </div>
  )
}

export function QuarterRankings({ year, kind, onBar }: { year: PmiYear; kind: MoneyKind; onBar: (name: string, q: PmiQuarter) => void }) {
  const label = kind === "apartados" ? "Apartados" : "Cierres"
  return (
    // Dos columnas y no cuatro: con nueve asesores (Yconia) una tarjeta de un
    // cuarto de ancho encima las caritas y los nombres.
    <div className="grid gap-4 md:grid-cols-2">
      {year.quarters.map((q) => {
        const notStarted = futureMonth(year, q.index * 3)
        return (
          <PmiRankingChart
            key={q.index}
            title={`${label} · ${q.label}`}
            rows={notStarted ? [] : kind === "apartados" ? q.rankingApartados : q.rankingCierres}
            objective={null}
            height={200}
            empty={notStarted ? "El trimestre no ha empezado." : `Sin ${label.toLowerCase()} en el trimestre.`}
            hint={q.index === 0
              ? <ScopePill label="Meta" tooltip={`${fmtMxn(PMI_OBJECTIVES[MONEY_KEY[kind]])} por asesor por cada mes del trimestre con actividad. El color de la barra es el semáforo contra esa meta.`} />
              : undefined}
            footer={notStarted ? undefined : <QuarterFooter q={q} kind={kind} />}
            onBar={(name) => onBar(name, q)}
          />
        )
      })}
    </div>
  )
}
