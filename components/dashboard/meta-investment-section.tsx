// components/dashboard/meta-investment-section.tsx
// "Inversión en pauta": lo que ① dejó en data.metaAds, en pantalla. Seis tiles y
// una línea de rendimiento sobre buildCostSummary / buildMetaReport — el mismo
// motor que usa el asistente, para que digan el mismo número. La tabla por
// campaña vive en paid-performance-table.tsx, que compone estos tiles arriba.
//
// Regla de filtros: el gasto sigue SOLO al filtro de fecha. Los filtros de
// atributo (asesor, status, origen…) recortan leads y ganadas, pero `gasto ÷
// leads de un asesor` sería un CPL falso, así que con atributos activos CPL y
// CPA salen "—" y el ScopePill lo explica.
"use client"

import { useMemo, type ReactNode } from "react"
import { Coins, Users, Receipt, Target, Trophy, HandCoins } from "lucide-react"
import { SummaryTile } from "@/components/dashboard/dashboard-ui"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { ResolvedDateRange } from "@/lib/date-range"
import type { Contact, MetaAdsData, MetaAdsStatus, Opportunity } from "@/lib/types"
import {
  buildCostSummary,
  buildMetaReport,
  classifyContact,
  classifyLead,
  contactAdId,
  localDay,
  type AttributionContext,
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
// Solo los KPIs de portada; la sección de la tabla la construye
// paid-performance-table.tsx (buildPaidReportSection).

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

// ── Cálculo ─────────────────────────────────────────────────────────────────

export interface MetaInvestment {
  summary: CostSummary
  /** Por campaña, gasto desc. */
  rows: MetaReportRow[]
  range: DayRange
  /** Filtros de atributo activos: CPL/CPA no se calculan. */
  costsSuppressed: boolean
  /** Los CONTACTOS `exact` de la ventana (los leads), y por campaña, sin tope. */
  exactContacts: Contact[]
  contactsByCampaign: Map<string, Contact[]>
  /** Las oportunidades `exact` de la ventana (el embudo debajo de los leads). */
  exactOpps: Opportunity[]
}

export function useMetaInvestment(p: {
  metaAds: MetaAdsData | null | undefined
  /** Ya filtrados por fecha Y atributos: el rango se vuelve a aplicar adentro. */
  contacts: Contact[]
  opportunities: Opportunity[]
  /** Del historial completo, construido UNA vez en marketing-dashboard y compartido
   *  con buildPaidPerformance: dos contextos podrían resolver un ad id distinto. */
  ctx: AttributionContext
  dateRange: ResolvedDateRange | null | undefined
  attributeFiltersActive: boolean
}): MetaInvestment | null {
  const { metaAds, contacts, opportunities, ctx, dateRange, attributeFiltersActive } = p
  const index = ctx.index
  // El mismo día LOCAL con el que el filtro recortó los registros.
  const range = useMemo<DayRange>(
    () => (dateRange ? { since: localDay(dateRange.from.toISOString()), until: localDay(dateRange.to.toISOString()) } : null),
    [dateRange]
  )
  return useMemo(() => {
    if (!metaAds) return null
    const base = { contacts, opportunities, meta: metaAds, index, range, ctx }
    const summary = buildCostSummary(base)
    const rows = buildMetaReport({ ...base, groupBy: "campaign" })
    const within = (iso: string) => !range || (localDay(iso) >= range.since && localDay(iso) <= range.until)
    const exactContacts = contacts.filter((c) => within(c.createdAt) && classifyContact(c, ctx) === "exact")
    const exactOpps = opportunities.filter((o) => within(o.createdAt) && classifyLead(o, ctx) === "exact")
    // El tope de 50 ids de buildMetaReport es para el asistente; el drawer del
    // panel debe abrir los 64 leads de una campaña con 64, así que se agrupan aquí.
    const contactsByCampaign = new Map<string, Contact[]>()
    for (const c of exactContacts) {
      const campaignId = index.byAd.get(contactAdId(c, ctx) ?? "")?.campaign?.id
      if (!campaignId) continue
      const list = contactsByCampaign.get(campaignId)
      if (list) list.push(c)
      else contactsByCampaign.set(campaignId, [c])
    }
    return { summary, rows, range, costsSuppressed: attributeFiltersActive, exactContacts, contactsByCampaign, exactOpps }
  }, [metaAds, index, ctx, contacts, opportunities, range, attributeFiltersActive])
}

// ── UI ──────────────────────────────────────────────────────────────────────
// Solo los tiles: la tabla vive en paid-performance-table.tsx, que compone
// estos tiles arriba cuando hay Meta.

export function metaScopeNote(inv: MetaInvestment, status?: MetaAdsStatus): ReactNode {
  const s = inv.summary
  return (
    <>
      Cohorte por fecha de creación: el gasto de la ventana contra los contactos creados en ella cuyo anuncio está en Meta (oportunidad → objeto Pauta → primera atribución → última). Oportunidades y ganadas son el embudo debajo.
      El gasto sigue solo al filtro de fecha; los filtros de atributo recortan leads y ganadas.
      {inv.costsSuppressed && " — Con filtros de atributo activos CPL y CPA no se calculan."}
      {s.mixedCurrency && " Las cuentas mezclan monedas: los costos no se consolidan."}
      {s.unknownAdLeads > 0 && ` ${int(s.unknownAdLeads)} leads traen un anuncio fuera de las cuentas asignadas.`}
      {status?.state === "partial" && ` Sin respuesta en el último sync: ${status.failedAccounts.map((f) => f.id).join(", ")}.`}
      {status?.state === "error" && " Meta no respondió en el último sync: gasto del último sync bueno."}
    </>
  )
}

export function MetaInvestmentTiles({ inv, onDrill }: { inv: MetaInvestment; onDrill: (d: DrillState) => void }) {
  const { summary: s, rows, costsSuppressed } = inv
  const currency = s.currency ?? "?"
  const cplShown = costsSuppressed || s.mixedCurrency ? null : s.cpl
  const cpaShown = costsSuppressed || s.mixedCurrency ? null : s.cpa
  const spendLabel = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)

  const drillOpps = (title: string, opps: Opportunity[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: opps })
  const drillContacts = (title: string, items: Contact[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryTile label="Gasto" icon={Coins} onClick={() => document.getElementById("meta-campaign-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}>
          <p className="mt-2 break-words text-[17px] font-bold leading-tight tabular-nums text-foreground sm:text-[22px] sm:leading-none">{spendLabel}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {inv.range ? `${inv.range.since} → ${inv.range.until}` : "todo el historial"}
          </p>
        </SummaryTile>

        <SummaryTile label="Leads CRM" icon={Users} onClick={() => drillContacts("Leads de Meta en el CRM", inv.exactContacts, "Contactos creados en la ventana con anuncio en Meta")}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.leadsCrm)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">Meta reportó {int(s.leadsMeta)}</p>
        </SummaryTile>

        <SummaryTile label="CPL" icon={Receipt} tone="accent" onClick={() => drillContacts("Leads de Meta en el CRM", inv.exactContacts)}>
          <p className="mt-2 break-words text-[17px] font-bold leading-tight tabular-nums text-primary sm:text-[22px] sm:leading-none">{money(cplShown, currency)}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">{costsSuppressed ? "no aplica con filtros" : "por lead del CRM"}</p>
        </SummaryTile>

        <SummaryTile label="Oportunidades" icon={Target} onClick={() => drillOpps("Oportunidades de Meta", inv.exactOpps, "Creadas en la ventana con anuncio en Meta (propio o de su contacto)")}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.opportunities)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
            {s.leadsCrm > 0 ? `${((s.opportunities / s.leadsCrm) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })}% de los leads` : "—"}
          </p>
        </SummaryTile>

        <SummaryTile label="Ganadas" icon={Trophy} onClick={() => drillOpps("Ganadas de Meta", inv.exactOpps.filter(isWonOpp))}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.won)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
            {s.opportunities > 0 ? `${((s.won / s.opportunities) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })}% de las opps` : "—"}
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
    </>
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
