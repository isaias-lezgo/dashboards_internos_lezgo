"use client"

import type { ReactNode } from "react"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { semaphore, type PmiRankingRow } from "@/lib/pmi"
import {
  DashboardCard, ChartCardHeader, ChartCardContent, ChartEmpty, ScopePill,
  NonZeroTooltipContent, CHART_TICK, CHART_GRID_STROKE, BRAND_AMBER,
} from "./dashboard-ui"
import { AvatarGlyph, fmtMxn, fmtMxnCompact, toneFill } from "./pmi-ui"

// El ranking del PMI como barras con la carita del asesor encima. Un solo
// componente para el mes, cada trimestre y el año: cambia la meta (una línea
// cuando es la misma para todos; ninguna cuando depende de los meses activos
// de cada uno) y el color de la barra sale del avance de la fila.

// Espacio arriba de la barra más alta para la carita (r 12) y el monto.
const LABEL_HEADROOM = 52

interface RankingLabelProps {
  x?: number | string
  y?: number | string
  width?: number | string
  index?: number
}

export function PmiRankingChart({
  title, rows, objective, onBar, hint, footer, empty = "Sin asesores con actividad en el período.", height = 220,
}: {
  title: string
  rows: PmiRankingRow[]
  /** Meta común a todos (la mensual); null cuando cada fila tiene la suya. */
  objective: number | null
  onBar: (name: string) => void
  hint?: ReactNode
  footer?: ReactNode
  empty?: string
  height?: number
}) {
  const data = rows.map((r) => ({ name: r.name, monto: r.monto, count: r.count, avance: r.avance }))
  // Una fila de puros $0 no es un ranking: el mensaje lo dice y la tabla de
  // abajo sigue listando a cada asesor.
  const allZero = data.length > 0 && data.every((d) => d.monto === 0)
  const renderLabel = (props: RankingLabelProps) => {
    const x = Number(props.x), y = Number(props.y), width = Number(props.width)
    const row = data[props.index ?? -1]
    if (!row || !Number.isFinite(x) || !Number.isFinite(y)) return null
    const cx = x + width / 2
    // Con muchas barras la carita se encoge para no pisar a la vecina, y el
    // monto se deja al tooltip cuando ya no cabe.
    const r = Math.max(8, Math.min(12, width * 0.45))
    const showMonto = width >= 28
    return (
      <g>
        <AvatarGlyph name={row.name} cx={cx} cy={y - (showMonto ? 22 : 6) - r} r={r} />
        {showMonto && (
          <text x={cx} y={y - 12} textAnchor="middle" fontSize={11} fontWeight={600} className="fill-foreground tabular-nums">
            {fmtMxnCompact(row.monto)}
          </text>
        )}
      </g>
    )
  }
  return (
    <DashboardCard className="h-full">
      <ChartCardHeader title={title}
        actions={hint ?? (objective !== null
          ? <ScopePill label="Meta" tooltip={`La línea marca la meta mensual por asesor: ${fmtMxn(objective)}. El color de la barra es el semáforo contra esa meta.`} />
          : undefined)} />
      <ChartCardContent>
        {data.length === 0 || allZero ? (
          <ChartEmpty message={empty} />
        ) : (
          <ChartContainer config={{ monto: { label: "Monto" } }} style={{ height }} className="w-full">
            <BarChart data={data} margin={{ top: LABEL_HEADROOM, right: 8, left: 8, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="name" tick={CHART_TICK} axisLine={false} tickLine={false} interval={0}
                tickFormatter={(v: string) => v.split(" ")[0]} />
              <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={52}
                tickFormatter={(v: number) => fmtMxnCompact(v)} />
              {objective !== null && (
                <ReferenceLine y={objective} stroke={BRAND_AMBER} strokeDasharray="4 4"
                  label={{ value: "META", position: "insideTopRight", fontSize: 10, fill: BRAND_AMBER }} />
              )}
              <ChartTooltip content={<NonZeroTooltipContent formatter={(v) => fmtMxn(Number(v))} />} />
              <Bar dataKey="monto" name="Monto" radius={[4, 4, 0, 0]} cursor="pointer" isAnimationActive={false}
                onClick={(d: { name?: string }) => { if (d?.name) onBar(String(d.name)) }}>
                {data.map((d) => (
                  <Cell key={d.name} fill={toneFill(d.avance === null ? null : semaphore(d.avance, 1))} fillOpacity={0.85} />
                ))}
                <LabelList dataKey="monto" content={renderLabel} />
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
        {footer}
      </ChartCardContent>
    </DashboardCard>
  )
}
