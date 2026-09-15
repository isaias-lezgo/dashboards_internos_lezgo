// components/dashboard/meta-investment-section.tsx
// "Inversión en pauta": lo que ① dejó en data.metaAds, en pantalla. Cinco tiles,
// una línea de rendimiento y la tabla por campaña, todo sobre buildCostSummary /
// buildMetaReport — el mismo motor que usan el PDF y el asistente, para que los
// tres digan el mismo número.
//
// Regla de filtros: el gasto sigue SOLO al filtro de fecha. Los filtros de
// atributo (asesor, status, origen…) recortan leads y ganadas, pero `gasto ÷
// leads de un asesor` sería un CPL falso, así que con atributos activos CPL y
// CPA salen "—" y el ScopePill lo explica.
"use client"

import { useMemo, useState } from "react"
import { Coins, Users, Receipt, Trophy, HandCoins } from "lucide-react"
import {
  DashboardCard,
  ChartCardHeader,
  ScopePill,
  SummaryTile,
  TopNSlider,
} from "@/components/dashboard/dashboard-ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { ResolvedDateRange } from "@/lib/date-range"
import type { MetaAdsData, MetaAdsStatus, Opportunity, Pauta } from "@/lib/types"
import type { ReportSection } from "@/lib/report"
import {
  buildCostSummary,
  buildMetaIndex,
  buildMetaReport,
  classifyLead,
  localDay,
  oppAdId,
  type CostSummary,
  type DayRange,
  type MetaReportRow,
} from "@/lib/meta-attribution"
import { isWonOpp } from "@/lib/opportunity-status"

// ── Formato ─────────────────────────────────────────────────────────────────

/** "$12,825.99 MXN"; "—" si null; con moneda "?" solo el número. */
export function money(n: number | null, currency: string): string {
  if (n === null) return "—"
  const num = n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "?" ? `$${num}` : `$${num} ${currency}`
}

export function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-MX", { maximumFractionDigits: 2 })}%`
}

function int(n: number): string {
  return n.toLocaleString("es-MX")
}

// ── PDF ─────────────────────────────────────────────────────────────────────
// La misma sección que se ve en pantalla, en bloques del spec de pdfmake. Se
// construye aquí y no en marketing-dashboard para que el panel y el PDF no
// puedan divergir en qué es "Inversión en pauta".

export function metaCoverKpis(inv: MetaInvestment): { label: string; value: string }[] {
  const s = inv.summary
  const currency = s.currency ?? "?"
  const spend = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)
  return [
    { label: "Gasto en Meta", value: spend },
    { label: "CPL", value: inv.costsSuppressed || s.mixedCurrency ? "—" : money(s.cpl, currency) },
  ]
}

export function buildMetaReportSection(inv: MetaInvestment): ReportSection {
  const s = inv.summary
  const currency = s.currency ?? "?"
  const suppressed = inv.costsSuppressed || s.mixedCurrency
  const top = inv.rows.slice(0, 15)
  // Misma regla que la tabla en pantalla: una sola moneda → al encabezado.
  const tableCurrencies = new Set(top.map((r) => r.currency))
  const tc = tableCurrencies.size === 1 ? Array.from(tableCurrencies)[0] : null
  const cell = (n: number | null, rowCurrency: string) => money(n, tc ? "?" : rowCurrency)
  const col = (c: string) => (tc && tc !== "?" && ["Gasto", "CPM", "CPL", "CPA"].includes(c) ? `${c} (${tc})` : c)
  return {
    id: "meta-investment",
    title: "Inversión en pauta",
    explanation:
      "Gasto de Meta Ads en el periodo, cruzado por id de anuncio con las oportunidades creadas en ese periodo. CPL y CPA usan los leads del CRM, no los que Meta reporta." +
      (inv.costsSuppressed ? " Con filtros de atributo activos el gasto no se recorta, por eso CPL y CPA no se calculan." : ""),
    blocks: [
      {
        t: "kpis",
        items: [
          ...metaCoverKpis(inv),
          { label: "Leads CRM", value: s.leadsCrm.toLocaleString("es-MX") },
          { label: "Leads Meta", value: s.leadsMeta.toLocaleString("es-MX") },
          { label: "Ganadas", value: s.won.toLocaleString("es-MX") },
          { label: "CPA", value: suppressed ? "—" : money(s.cpa, currency) },
          { label: "Impresiones", value: inv.rows.reduce((a, r) => a + r.impressions, 0).toLocaleString("es-MX") },
          { label: "Clics", value: inv.rows.reduce((a, r) => a + r.clicks, 0).toLocaleString("es-MX") },
        ],
      },
      {
        t: "table",
        headers: ["Campaña", "Gasto", "Impr.", "Clics", "CPM", "CTR", "Leads Meta", "Leads CRM", "Ganadas", "CPL", "CPA"].map(col),
        rows: top.map((r) => [
          r.label,
          cell(r.spend, r.currency),
          r.impressions.toLocaleString("es-MX"),
          r.clicks.toLocaleString("es-MX"),
          cell(r.cpm, r.currency),
          pct(r.ctr),
          r.leadsMeta.toLocaleString("es-MX"),
          r.leadsCrm.toLocaleString("es-MX"),
          r.won.toLocaleString("es-MX"),
          suppressed ? "—" : cell(r.cpl, r.currency),
          suppressed ? "—" : cell(r.cpa, r.currency),
        ]),
      },
    ],
  }
}

// ── Cálculo ─────────────────────────────────────────────────────────────────

export interface MetaInvestment {
  summary: CostSummary
  /** Por campaña, gasto desc. */
  rows: MetaReportRow[]
  /** Campaña → sus oportunidades `exact` de la ventana, SIN tope: el drill debe traer todas. */
  oppsByCampaign: Map<string, Opportunity[]>
  range: DayRange
  /** Filtros de atributo activos: CPL/CPA no se calculan. */
  costsSuppressed: boolean
  oppById: Map<string, Opportunity>
  /** Las opps `exact` de la ventana, para los tiles. */
  exactOpps: Opportunity[]
}

export function useMetaInvestment(p: {
  metaAds: MetaAdsData | null | undefined
  /** Ya filtradas por fecha Y atributos: el rango se vuelve a aplicar adentro. */
  opportunities: Opportunity[]
  pautas: Pauta[]
  dateRange: ResolvedDateRange | null | undefined
  attributeFiltersActive: boolean
}): MetaInvestment | null {
  const { metaAds, opportunities, pautas, dateRange, attributeFiltersActive } = p
  const index = useMemo(() => (metaAds ? buildMetaIndex(metaAds) : null), [metaAds])
  const pautaContacts = useMemo(() => {
    const s = new Set<string>()
    for (const x of pautas) if (x.contactId) s.add(x.contactId)
    return s
  }, [pautas])
  // El mismo día LOCAL con el que el filtro recortó las oportunidades.
  const range = useMemo<DayRange>(
    () => (dateRange ? { since: localDay(dateRange.from.toISOString()), until: localDay(dateRange.to.toISOString()) } : null),
    [dateRange]
  )
  return useMemo(() => {
    if (!metaAds || !index) return null
    const base = { opportunities, meta: metaAds, index, range, pautaContacts }
    const summary = buildCostSummary(base)
    const rows = buildMetaReport({ ...base, groupBy: "campaign" })
    const oppById = new Map(opportunities.map((o) => [o.id, o]))
    const ctx = { index, pautaContacts }
    const exactOpps = opportunities.filter(
      (o) => (!range || (localDay(o.createdAt) >= range.since && localDay(o.createdAt) <= range.until)) && classifyLead(o, ctx) === "exact"
    )
    // El tope de 50 ids de buildMetaReport es para el asistente; el drawer del
    // panel debe abrir las 64 de una campaña con 64, así que se agrupan aquí.
    const oppsByCampaign = new Map<string, Opportunity[]>()
    for (const o of exactOpps) {
      const campaignId = index.byAd.get(oppAdId(o) ?? "")?.campaign?.id
      if (!campaignId) continue
      const list = oppsByCampaign.get(campaignId)
      if (list) list.push(o)
      else oppsByCampaign.set(campaignId, [o])
    }
    return { summary, rows, range, costsSuppressed: attributeFiltersActive, oppById, exactOpps, oppsByCampaign }
  }, [metaAds, index, opportunities, range, pautaContacts, attributeFiltersActive])
}

// ── UI ──────────────────────────────────────────────────────────────────────

const TABLE_COLS = ["Campaña", "Gasto", "Impr.", "Clics", "CPM", "CTR", "Leads Meta", "Leads CRM", "Ganadas", "CPL", "CPA"]

export function MetaInvestmentSection({
  inv,
  status,
  onDrill,
}: {
  inv: MetaInvestment
  status?: MetaAdsStatus
  onDrill: (d: DrillState) => void
}) {
  const { summary: s, rows, costsSuppressed } = inv
  const [topN, setTopN] = useState(10)

  const currency = s.currency ?? "?"
  const cplShown = costsSuppressed || s.mixedCurrency ? null : s.cpl
  const cpaShown = costsSuppressed || s.mixedCurrency ? null : s.cpa
  const spendLabel = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)

  const visible = topN >= rows.length ? rows : rows.slice(0, topN)
  // Una sola moneda en la tabla → va en el encabezado y las celdas quedan
  // limpias; con monedas mezcladas cada celda lleva la suya.
  const tableCurrencies = new Set(rows.map((r) => r.currency))
  const tableCurrency = tableCurrencies.size === 1 ? Array.from(tableCurrencies)[0] : null
  const cell = (n: number | null, rowCurrency: string) => money(n, tableCurrency ? "?" : rowCurrency)
  const colLabel = (c: string) =>
    tableCurrency && tableCurrency !== "?" && ["Gasto", "CPM", "CPL", "CPA"].includes(c) ? `${c} (${tableCurrency})` : c
  const rest = rows.slice(visible.length)
  const restSpend = rest.reduce((a, r) => a + r.spend, 0)
  const restLeads = rest.reduce((a, r) => a + r.leadsCrm, 0)

  const drillOpps = (title: string, opps: Opportunity[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: opps })

  const scopeTooltip = (
    <>
      Cohorte por fecha de creación: el gasto de la ventana contra las oportunidades creadas en ella cuyo anuncio está en Meta.
      El gasto sigue solo al filtro de fecha; los filtros de atributo recortan leads y ganadas.
      {costsSuppressed && " — Con filtros de atributo activos CPL y CPA no se calculan."}
      {s.mixedCurrency && " Las cuentas mezclan monedas: los costos no se consolidan."}
      {s.unknownAdLeads > 0 && ` ${int(s.unknownAdLeads)} leads traen un anuncio fuera de las cuentas asignadas.`}
      {status?.state === "partial" && ` Sin respuesta en el último sync: ${status.failedAccounts.map((f) => f.id).join(", ")}.`}
      {status?.state === "error" && " Meta no respondió en el último sync: gasto del último sync bueno."}
    </>
  )

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión en pauta"
        icon={Coins}
        actions={<ScopePill label={costsSuppressed ? "sin costos con filtros" : "cohorte por fecha"} tooltip={scopeTooltip} />}
      />

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryTile label="Gasto" icon={Coins} onClick={() => document.getElementById("meta-campaign-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}>
          <p className="mt-2 break-words text-[17px] font-bold leading-tight tabular-nums text-foreground sm:text-[22px] sm:leading-none">{spendLabel}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {inv.range ? `${inv.range.since} → ${inv.range.until}` : "todo el historial"}
          </p>
        </SummaryTile>

        <SummaryTile label="Leads CRM" icon={Users} onClick={() => drillOpps("Leads de Meta en el CRM", inv.exactOpps, "Oportunidades creadas en la ventana con anuncio en Meta")}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.leadsCrm)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">Meta reportó {int(s.leadsMeta)}</p>
        </SummaryTile>

        <SummaryTile label="CPL" icon={Receipt} tone="accent" onClick={() => drillOpps("Leads de Meta en el CRM", inv.exactOpps)}>
          <p className="mt-2 break-words text-[17px] font-bold leading-tight tabular-nums text-primary sm:text-[22px] sm:leading-none">{money(cplShown, currency)}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">{costsSuppressed ? "no aplica con filtros" : "por lead del CRM"}</p>
        </SummaryTile>

        <SummaryTile label="Ganadas" icon={Trophy} onClick={() => drillOpps("Ganadas de Meta", inv.exactOpps.filter(isWonOpp))}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.won)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
            {s.leadsCrm > 0 ? `${((s.won / s.leadsCrm) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })}% de los leads` : "—"}
          </p>
        </SummaryTile>

        <SummaryTile label="CPA" icon={HandCoins} onClick={() => drillOpps("Ganadas de Meta", inv.exactOpps.filter(isWonOpp))}>
          <p className="mt-2 break-words text-[17px] font-bold leading-tight tabular-nums text-foreground sm:text-[22px] sm:leading-none">{money(cpaShown, currency)}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">{costsSuppressed ? "no aplica con filtros" : "por venta"}</p>
        </SummaryTile>
      </div>

      <p className="mt-3 text-[11px] tabular-nums text-muted-foreground">
        Impresiones {int(rows.reduce((a, r) => a + r.impressions, 0))} · Clics {int(rows.reduce((a, r) => a + r.clicks, 0))} · CPM{" "}
        {s.mixedCurrency ? "—" : money(cpmOf(rows), currency)} · CTR {pct(ctrOf(rows))}
      </p>

      <div id="meta-campaign-table" className="mt-5 flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">Gasto y costo por campaña</h4>
        <TopNSlider value={topN} max={rows.length} onChange={setTopN} />
      </div>
      <div className="mt-2 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {TABLE_COLS.map((c, i) => (
                <TableHead key={c} className={i === 0 ? "min-w-[14rem]" : "whitespace-nowrap text-right"}>{colLabel(c)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow
                key={r.key}
                className="cursor-pointer"
                onClick={() => drillOpps(r.label, inv.oppsByCampaign.get(r.key) ?? [], `${int(r.leadsCrm)} leads · ${money(r.spend, r.currency)}`)}
              >
                <TableCell className="max-w-[22rem] truncate font-medium" title={r.label}>{r.label}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{cell(r.spend, r.currency)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(r.impressions)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(r.clicks)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{cell(r.cpm, r.currency)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{pct(r.ctr)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(r.leadsMeta)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(r.leadsCrm)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(r.won)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{cell(costsSuppressed ? null : r.cpl, r.currency)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{cell(costsSuppressed ? null : r.cpa, r.currency)}</TableCell>
              </TableRow>
            ))}
            {rest.length > 0 && (
              <TableRow className="text-muted-foreground">
                <TableCell className="font-medium">Otras ({int(rest.length)})</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{cell(restSpend, currency)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(rest.reduce((a, r) => a + r.impressions, 0))}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(rest.reduce((a, r) => a + r.clicks, 0))}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(rest.reduce((a, r) => a + r.leadsMeta, 0))}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(restLeads)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{int(rest.reduce((a, r) => a + r.won, 0))}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
              </TableRow>
            )}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={TABLE_COLS.length} className="text-center text-muted-foreground">Sin gasto en la ventana</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </DashboardCard>
  )
}

function cpmOf(rows: MetaReportRow[]): number | null {
  const imp = rows.reduce((a, r) => a + r.impressions, 0)
  const spend = rows.reduce((a, r) => a + r.spend, 0)
  return imp > 0 ? (spend / imp) * 1000 : null
}

function ctrOf(rows: MetaReportRow[]): number | null {
  const imp = rows.reduce((a, r) => a + r.impressions, 0)
  return imp > 0 ? rows.reduce((a, r) => a + r.clicks, 0) / imp : null
}
