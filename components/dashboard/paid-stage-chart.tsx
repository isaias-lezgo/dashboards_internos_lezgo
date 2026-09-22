// components/dashboard/paid-stage-chart.tsx
// "Etapa del pipeline por pauta": UNA barra por campaña / URL / ID de anuncio,
// apilada por etapa en orden del pipeline. Responde "¿hasta dónde llegan los
// leads de cada pauta?", que la tabla de rendimiento contesta fila por fila con
// su barra chica y aquí se ve de un golpe para las N pautas más grandes.
//
// Lee el MISMO resultado que la tabla (buildPaidPerformance, con groupBy "url" |
// "ad" además de "campaign"): las etapas de una campaña aquí y en la tabla son el
// mismo arreglo, así que no pueden diferir. Aquí solo hay estado de vista: Top N,
// búsqueda. La sección del PDF se construye en este archivo por la misma razón
// que la de la tabla: pantalla y papel no pueden divergir en qué es "etapa".
//
// La etapa es ORDINAL: un solo tono (el primario) de claro a oscuro conforme la
// oportunidad avanza, y las perdidas en rojo apagado al final — la misma
// convención que la barra de etapas de la tabla. No hay leyenda que decodificar:
// el hover dice etapa y cuenta, y la tira de etapas debajo del chart da el orden.
"use client"

import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts"
import { Layers, Search } from "lucide-react"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  ChartHint,
  DashboardCard,
  NonZeroTooltipContent,
  ScopePill,
  TopNSlider,
} from "@/components/dashboard/dashboard-ui"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { Opportunity } from "@/lib/types"
import { sumRows, type PaidGroup, type PaidGroupBy, type PaidRow, type StageCount } from "@/lib/paid-performance"
import type { ReportSection } from "@/lib/report"

/** Los modos de esta gráfica; "platform" queda fuera: un anuncio produce varios orígenes. */
export type PaidStageGroupBy = Extract<PaidGroupBy, "campaign" | "url" | "ad">

const GROUP_OPTIONS: { v: PaidStageGroupBy; label: string }[] = [
  { v: "campaign", label: "Campaña" },
  { v: "url", label: "URL" },
  { v: "ad", label: "ID" },
]

const NOUN: Record<PaidStageGroupBy, { one: string; many: string }> = {
  campaign: { one: "campaña", many: "campañas" },
  url: { one: "URL de atribución", many: "URLs de atribución" },
  ad: { one: "ID de anuncio", many: "IDs de anuncio" },
}

const OTRAS_KEY = "__otras"
const LABEL_W = 200

// ── Color ───────────────────────────────────────────────────────────────────
// Rampa de un solo tono (el primario, hue 35) de L 60 % a 30 %: el extremo claro
// guarda ≥ 2:1 contra la tarjeta, el oscuro sigue siendo el primario y no café.
// Las perdidas van en rojo apagado, un color de estado, nunca parte de la rampa.

function stageFill(index: number, live: number, lost: boolean): string {
  if (lost) return "hsl(0 60% 58%)"
  const t = live <= 1 ? 1 : index / (live - 1)
  return `hsl(35 85% ${(60 - 30 * t).toFixed(1)}%)`
}

function shortLabel(label: string, groupBy: PaidStageGroupBy): string {
  if (groupBy === "url") {
    try {
      const u = new URL(label)
      const slug = u.pathname.replace(/\/$/, "").split("/").pop() || ""
      const s = `${u.hostname.replace(/^www\./, "")}/${slug}`
      return s.length > 30 ? s.slice(0, 30) + "…" : s
    } catch {
      /* no es URL: cae al recorte de abajo */
    }
  }
  return label.length > 30 ? label.slice(0, 30) + "…" : label
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

// ── Filas ───────────────────────────────────────────────────────────────────
// Los grupos con 0 oportunidades (un anuncio de Meta que gasta sin traer leads)
// no tienen etapa que mostrar y se omiten. El orden de etapas es la unión de
// todas las filas, pipeline primero y perdidas al final — el mismo criterio que
// StageCount.order, de modo que la tira y las barras no puedan discrepar.

function stageOrderOf(rows: PaidRow[]): StageCount[] {
  return Array.from(new Map(rows.flatMap((g) => g.stages).map((s) => [s.stage, s])).values())
    .sort((x, y) => Number(x.lost) - Number(y.lost) || x.order - y.order || x.stage.localeCompare(y.stage))
}

type ChartRow = { key: string; label: string; total: number } & Record<string, string | number>

function toChartRows(rows: PaidRow[], stages: StageCount[]): ChartRow[] {
  return rows.map((g) => {
    const row: ChartRow = { key: g.key, label: g.label, total: g.opportunities }
    for (const s of stages) row[s.stage] = g.stages.find((x) => x.stage === s.stage)?.count ?? 0
    return row
  })
}

// ── Tarjeta ─────────────────────────────────────────────────────────────────

export interface PaidStageChartProps {
  groups: PaidGroup[]
  groupBy: PaidStageGroupBy
  onGroupByChange: (v: PaidStageGroupBy) => void
  includeLost: boolean
  onIncludeLostChange: (v: boolean) => void
  /** Ventana: resuelve oppIds para el drawer. */
  opportunities: Opportunity[]
  onDrill: (d: DrillState) => void
}

export function PaidStageChart(props: PaidStageChartProps) {
  const { groups, groupBy, onGroupByChange, includeLost, onIncludeLostChange, opportunities, onDrill } = props
  const [topN, setTopN] = useState(15)
  const [query, setQuery] = useState("")

  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])

  // Orden por opps → búsqueda → Top N (la búsqueda apaga el Top N, como en la tabla).
  const { visible, otras, total, stages, rows, keyCount } = useMemo(() => {
    const withOpps = groups.filter((g) => g.opportunities > 0).sort((a, b) => b.opportunities - a.opportunities || a.label.localeCompare(b.label))
    const q = fold(query.trim())
    const filtered = q ? withOpps.filter((g) => fold(g.label).includes(q)) : withOpps
    const cut = q || topN >= filtered.length ? filtered : filtered.slice(0, topN)
    const rest = filtered.slice(cut.length)
    const otras = rest.length > 0 ? sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`) : null
    const shown: PaidRow[] = otras ? [...cut, otras] : cut
    const stages = stageOrderOf(shown)
    return {
      visible: cut,
      otras,
      total: withOpps.reduce((a, g) => a + g.opportunities, 0),
      stages,
      rows: toChartRows(shown, stages),
      keyCount: filtered.length,
    }
  }, [groups, query, topN])

  const live = stages.filter((s) => !s.lost).length
  const config = Object.fromEntries(stages.map((s, i) => [s.stage, { label: s.stage, color: stageFill(i, live, s.lost) }]))
  const byKey = useMemo(() => new Map<string, PaidRow>([...visible.map((g) => [g.key, g] as const), ...(otras ? [[OTRAS_KEY, otras] as const] : [])]), [visible, otras])

  const drillSegment = (rowKey: string, stage: string) => {
    const row = byKey.get(rowKey)
    if (!row) return
    const items = row.oppIds.map((id) => oppById.get(id)).filter((o): o is Opportunity => !!o && o.stage === stage)
    if (items.length === 0) return
    onDrill({
      open: true,
      title: `${row.label} · ${stage}`,
      subtitle: `${items.length} oportunidad${items.length !== 1 ? "es" : ""} en ${stage}`,
      opportunities: items,
    })
  }

  const noun = NOUN[groupBy]
  const height = Math.min(760, Math.max(240, rows.length * 34 + 72))

  return (
    <DashboardCard>
      <ChartCardHeader
        title={`Etapa del pipeline por pauta${includeLost ? "" : " (sin perdidas)"}`}
        total={total}
        icon={Layers}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ScopePill
              label={`por ${noun.one}`}
              tooltip={
                <>
                  Una barra por {noun.one}, apilada por etapa en orden del pipeline: más oscuro es más avanzado; las perdidas van en rojo al final.
                  {" "}Las mismas oportunidades y el mismo anuncio que la tabla de rendimiento.
                  {groupBy !== "campaign" && " Sin inversión: el gasto solo se reparte por campaña."}
                </>
              }
            />
            <label className="relative inline-flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Buscar ${noun.one}…`}
                aria-label={`Buscar ${noun.one}`}
                className="h-6 w-40 rounded border border-border/60 bg-transparent pl-6 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <TopNSlider value={topN} max={keyCount} onChange={setTopN} disabled={query.trim().length > 0} />
            <button
              type="button"
              onClick={() => onIncludeLostChange(!includeLost)}
              className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
            >
              Perdidas
              <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${includeLost ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
                <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${includeLost ? "translate-x-2.5" : "translate-x-0.5"}`} />
              </span>
            </button>
            <div className="inline-flex shrink-0 rounded-md border border-border/60 p-0.5" role="group" aria-label="Agrupar por">
              {GROUP_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => onGroupByChange(o.v)}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${groupBy === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <ChartCardContent>
        {rows.length === 0 ? (
          <ChartEmpty
            message={query.trim() ? `Ninguna ${noun.one} contiene "${query.trim()}".` : `Sin oportunidades de pauta${includeLost ? "" : " abiertas o ganadas"} en el periodo.`}
            height={240}
          />
        ) : (
          <>
            <ChartContainer config={config} className="aspect-auto" style={{ height }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 40, left: 8, bottom: 4 }} barCategoryGap="28%">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={LABEL_W}
                    tick={{ fontSize: 11, fill: CHART_TICK.fill }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    tickFormatter={(v: string) => shortLabel(v, groupBy)}
                  />
                  <ChartTooltip content={<NonZeroTooltipContent />} />
                  {stages.map((s, i) => (
                    <Bar
                      key={s.stage}
                      dataKey={s.stage}
                      stackId="a"
                      fill={stageFill(i, live, s.lost)}
                      stroke="hsl(var(--card))"
                      strokeWidth={1}
                      radius={i === stages.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                      maxBarSize={26}
                      cursor="pointer"
                      onClick={(data: unknown) => {
                        const d = data as ChartRow
                        if (!(d[s.stage] as number)) return
                        drillSegment(d.key, s.stage)
                      }}
                    >
                      {i === stages.length - 1 && (
                        <LabelList dataKey="total" position="right" style={{ fontSize: 11, fill: CHART_TICK.fill }} />
                      )}
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
            <ol className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Etapas en orden del pipeline">
              {stages.map((s, i) => (
                <li key={s.stage} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: stageFill(i, live, s.lost) }} aria-hidden />
                  {s.stage}
                </li>
              ))}
            </ol>
            <ChartHint>
              {`${keyCount} ${noun.many}${query.trim() ? ` que contienen "${query.trim()}"` : topN < keyCount ? ` · top ${topN}` : ""} · haz clic en un segmento para ver las oportunidades`}
            </ChartHint>
          </>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}

// ── Sección del PDF ─────────────────────────────────────────────────────────
// Etapa × pauta como TABLA (top 6 por opps + Otras): en papel una apilada de
// doce tonos no se lee; una tabla sí. Antes vivía dentro de la sección de la
// tabla de rendimiento; se movió aquí para que siga a los toggles de esta
// tarjeta (agrupación y perdidas), que son los que el lector ve en pantalla.

export function buildPaidStageReportSection(p: {
  groups: PaidGroup[]
  groupBy: PaidStageGroupBy
  includeLost: boolean
}): ReportSection | null {
  const byOpps = p.groups.filter((g) => g.opportunities > 0).sort((a, b) => b.opportunities - a.opportunities)
  if (byOpps.length === 0) return null
  const cols = byOpps.slice(0, 6)
  const rest = byOpps.slice(6)
  const colRows: PaidRow[] = rest.length > 0 ? [...cols, sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`)] : cols
  const stages = stageOrderOf(colRows)
  const total = byOpps.reduce((a, g) => a + g.opportunities, 0)
  const noun = NOUN[p.groupBy]
  const int = (n: number) => n.toLocaleString("es-MX")
  return {
    id: "pauta-etapa",
    title: "Oportunidades de pauta por etapa del pipeline",
    explanation:
      `Dónde están hoy las oportunidades que vienen de pauta dentro del pipeline de ventas${p.includeLost ? "" : " (sin contar las perdidas)"}, una columna por ${noun.one} (las ${cols.length} con más oportunidades; el resto en Otras). ` +
      "Muestra qué tan profundo avanza el tráfico pagado en el embudo y qué pautas sostienen cada etapa. Es el mismo cruce por anuncio que la tabla de inversión y rendimiento.",
    blocks: [
      { t: "subheading", text: `Oportunidades de pauta por etapa${p.includeLost ? "" : " (sin perdidas)"} (total: ${int(total)})` },
      {
        t: "table",
        headers: ["Etapa", ...colRows.map((g) => shortLabel(g.label, p.groupBy))],
        rows: stages.map((s) => [s.stage, ...colRows.map((g) => int(g.stages.find((x) => x.stage === s.stage)?.count ?? 0))]),
      },
    ],
  }
}
