// components/dashboard/paid-performance-table.tsx
// "Inversión y rendimiento de pauta": UNA tarjeta que reemplaza a la tabla de
// inversión de Meta y a las gráficas de etapa, ID de anuncio, URL y citas por
// pauta. Filas expandibles campaña → anuncios (ID con copiar, URL con abrir);
// toggle Campaña | Origen; buscador; Top N; toggle Perdidas; editor de columnas;
// barra de etapas por fila; cada número abre sus registros.
//
// Todo el cálculo está en lib/paid-performance.ts (puro). Aquí solo hay estado
// de vista: orden, expansión, columnas visibles, búsqueda. La sección del PDF
// (buildPaidReportSection) se construye en este archivo para que pantalla y
// papel no puedan divergir en qué es "rendimiento de pauta".
//
// Spec: docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md
"use client"

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Coins, Columns3, Search, Facebook, Instagram, Link2 } from "lucide-react"
import {
  ChartCardHeader,
  ChartEmpty,
  ChartHint,
  CopyButton,
  DashboardCard,
  LinkButton,
  ScopePill,
  TopNSlider,
} from "@/components/dashboard/dashboard-ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { Contact, MetaAdsStatus, Opportunity } from "@/lib/types"
import {
  buildPaidPerformance,
  sumRows,
  type PaidGroup,
  type PaidGroupBy,
  type PaidPerformanceInput,
  type PaidRow,
  type StageCount,
} from "@/lib/paid-performance"
import { isWonOpp } from "@/lib/opportunity-status"
import type { ReportSection } from "@/lib/report"
import { MetaInvestmentTiles, metaScopeNote, money, pct, type MetaInvestment } from "./meta-investment-section"

// ── Columnas ────────────────────────────────────────────────────────────────

export type PaidColumnId =
  | "spend" | "impressions" | "clicks" | "cpm" | "ctr"
  | "leadsMeta" | "leadsCrm" | "opportunities" | "won" | "cpl" | "cpa"
  | "appointments" | "showed" | "stages"

export const PAID_COLUMNS: { id: PaidColumnId; label: string; group: "inversion" | "leads" | "citas" | "etapas"; meta: boolean; defaultOn: boolean }[] = [
  { id: "spend", label: "Gasto", group: "inversion", meta: true, defaultOn: true },
  { id: "impressions", label: "Impr.", group: "inversion", meta: true, defaultOn: false },
  { id: "clicks", label: "Clics", group: "inversion", meta: true, defaultOn: false },
  { id: "cpm", label: "CPM", group: "inversion", meta: true, defaultOn: false },
  { id: "ctr", label: "CTR", group: "inversion", meta: true, defaultOn: true },
  { id: "leadsMeta", label: "Leads Meta", group: "leads", meta: true, defaultOn: true },
  { id: "leadsCrm", label: "Leads CRM", group: "leads", meta: false, defaultOn: true },
  { id: "opportunities", label: "Opps", group: "leads", meta: false, defaultOn: true },
  { id: "won", label: "Ganadas", group: "leads", meta: false, defaultOn: true },
  { id: "cpl", label: "CPL", group: "leads", meta: true, defaultOn: true },
  { id: "cpa", label: "CPA", group: "leads", meta: true, defaultOn: true },
  { id: "appointments", label: "Citas", group: "citas", meta: false, defaultOn: true },
  { id: "showed", label: "Efectivas", group: "citas", meta: false, defaultOn: true },
  { id: "stages", label: "Etapas", group: "etapas", meta: false, defaultOn: true },
]

const MONEY_COLS = new Set<PaidColumnId>(["spend", "cpm", "cpl", "cpa"])
const OTRAS_KEY = "__otras"

// ── Hook ────────────────────────────────────────────────────────────────────

export function usePaidPerformance(p: PaidPerformanceInput): PaidGroup[] {
  const { opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta } = p
  return useMemo(
    () => buildPaidPerformance({ opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta }),
    [opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta]
  )
}

// ── Formato ─────────────────────────────────────────────────────────────────

function int(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("es-MX")
}

function shortUrl(href: string): string {
  try {
    const u = new URL(href)
    const slug = u.pathname.replace(/\/$/, "").split("/").pop() || ""
    const host = u.hostname.replace(/^www\./, "")
    const s = `${host}/${slug}`
    return s.length > 26 ? s.slice(0, 26) + "…" : s
  } catch {
    return href.length > 26 ? href.slice(0, 26) + "…" : href
  }
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
}

// ── Controles ───────────────────────────────────────────────────────────────

function SegmentedToggle<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border/60 p-0.5" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${value === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SwitchButton({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-2.5" : "translate-x-0.5"}`} />
      </span>
    </button>
  )
}

// ── Columnas visibles ───────────────────────────────────────────────────────
// Conveniencia por navegador (localStorage), no estado del negocio: si la
// lectura falla —modo privado, datos borrados— se usan los defaults y ya.

const COLS_STORAGE_KEY = "paid-performance-cols"

function defaultColumns(): Set<PaidColumnId> {
  return new Set(PAID_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id))
}

function readStoredColumns(): Set<PaidColumnId> | null {
  try {
    const raw = window.localStorage.getItem(COLS_STORAGE_KEY)
    if (!raw) return null
    const ids = new Set<string>(PAID_COLUMNS.map((c) => c.id))
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is PaidColumnId => typeof x === "string" && ids.has(x)))
  } catch {
    return null
  }
}

function useVisibleColumns(showMeta: boolean): [Set<PaidColumnId>, (next: Set<PaidColumnId>) => void] {
  const [chosen, setChosen] = useState<Set<PaidColumnId>>(defaultColumns)
  // Hidratar desde localStorage después del primer render: el servidor no lo tiene.
  useEffect(() => {
    const stored = readStoredColumns()
    if (stored) setChosen(stored)
  }, [])
  const set = (next: Set<PaidColumnId>) => {
    setChosen(next)
    try {
      window.localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(Array.from(next)))
    } catch {
      /* sin memoria en este navegador: la sesión sigue */
    }
  }
  // Sin Meta las columnas de Meta no existen aunque estén elegidas.
  const visible = useMemo(
    () => new Set(Array.from(chosen).filter((id) => showMeta || !PAID_COLUMNS.find((c) => c.id === id)?.meta)),
    [chosen, showMeta]
  )
  return [visible, set]
}

const GROUP_LABELS: Record<(typeof PAID_COLUMNS)[number]["group"], string> = {
  inversion: "Inversión",
  leads: "Leads y costo",
  citas: "Citas",
  etapas: "Etapas",
}

function ColumnEditor({ showMeta, value, onChange }: { showMeta: boolean; value: Set<PaidColumnId>; onChange: (next: Set<PaidColumnId>) => void }) {
  const groupsInOrder = ["inversion", "leads", "citas", "etapas"] as const
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
          <Columns3 className="h-3.5 w-3.5" /> Columnas
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        {groupsInOrder.map((g) => {
          const cols = PAID_COLUMNS.filter((c) => c.group === g && (showMeta || !c.meta))
          if (cols.length === 0) return null
          return (
            <div key={g} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_LABELS[g]}</p>
              {cols.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                  <Checkbox
                    checked={value.has(c.id)}
                    onCheckedChange={(on) => {
                      const next = new Set(value)
                      if (on) next.add(c.id)
                      else next.delete(c.id)
                      onChange(next)
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )
        })}
        <button type="button" className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => onChange(defaultColumns())}>
          Restablecer
        </button>
      </PopoverContent>
    </Popover>
  )
}

// ── Barra de etapas ─────────────────────────────────────────────────────────
// Segmentos proporcionales en orden del pipeline: el primario con opacidad
// creciente conforme la etapa avanza (no requiere leyenda: el hover dice la
// etapa y la cuenta), y las perdidas en rojo apagado al final. El ancho es
// relativo a la fila — los números absolutos van en las columnas de al lado.

function stageStyle(index: number, live: number, lost: boolean): CSSProperties {
  if (lost) return { backgroundColor: "rgb(239 68 68 / 0.45)" }
  const t = live <= 1 ? 1 : index / (live - 1)
  return { backgroundColor: `hsl(var(--primary) / ${(0.3 + 0.7 * t).toFixed(2)})` }
}

function StageBar({ stages, onSegmentClick }: { stages: StageCount[]; onSegmentClick: (s: StageCount) => void }) {
  const total = stages.reduce((a, s) => a + s.count, 0)
  if (total === 0) return null
  const live = stages.filter((s) => !s.lost).length
  return (
    <TooltipProvider delayDuration={80}>
      <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted/30" role="img" aria-label={stages.map((s) => `${s.stage} ${s.count}`).join(" · ")}>
        {stages.map((s, i) => (
          <Tooltip key={s.stage}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="h-full min-w-[3px] transition-opacity hover:opacity-80"
                style={{ width: `${(s.count / total) * 100}%`, ...stageStyle(i, live, s.lost) }}
                onClick={(e) => { e.stopPropagation(); onSegmentClick(s) }}
                aria-label={`${s.stage}: ${s.count}`}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {s.stage} · {s.count.toLocaleString("es-MX")}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}

// ── Tabla ───────────────────────────────────────────────────────────────────

export interface PaidPerformanceTableProps {
  groups: PaidGroup[]
  groupBy: PaidGroupBy
  onGroupByChange: (v: PaidGroupBy) => void
  includeLost: boolean
  onIncludeLostChange: (v: boolean) => void
  hasMeta: boolean
  costsSuppressed: boolean
  metaInv: MetaInvestment | null
  status?: MetaAdsStatus
  /** Ventana (resuelve oppIds/contactIds) e historial (joins del drawer). */
  opportunities: Opportunity[]
  contacts: Contact[]
  allOpportunities: Opportunity[]
  onDrill: (d: DrillState) => void
}

type SortKey = Exclude<PaidColumnId, "stages">
type Sort = { key: SortKey; dir: "asc" | "desc" }
type RowOpts = { isChild: boolean; isOtras: boolean; expandable: boolean; isOpen: boolean }

export function PaidPerformanceTable(props: PaidPerformanceTableProps) {
  const { groups, groupBy, onGroupByChange, includeLost, onIncludeLostChange, hasMeta, costsSuppressed, metaInv, status, opportunities, contacts, allOpportunities, onDrill } = props
  const showMeta = hasMeta && groupBy === "campaign"

  const [query, setQuery] = useState("")
  const [topN, setTopN] = useState(15)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [sort, setSort] = useState<Sort | null>(null)
  const [visibleCols, setVisibleCols] = useVisibleColumns(showMeta)

  const effectiveSort: Sort = sort ?? { key: showMeta ? "spend" : "opportunities", dir: "desc" }

  // Moneda única de la tabla → al encabezado; mezclada → cada celda la suya.
  const tableCurrency = useMemo(() => {
    const set = new Set(groups.map((g) => g.currency).filter((c): c is string => !!c && c !== "?"))
    return set.size === 1 ? Array.from(set)[0] : null
  }, [groups])

  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

  // Orden → búsqueda → Top N. La búsqueda desactiva el Top N: quien busca quiere
  // ver lo que buscó, no el top de lo que buscó.
  const { visible, otras, total } = useMemo(() => {
    const dir = effectiveSort.dir === "asc" ? 1 : -1
    const val = (r: PaidRow) => (r[effectiveSort.key] as number | null) ?? -Infinity
    const byKey = (a: PaidRow, b: PaidRow) => (val(a) - val(b)) * dir || a.label.localeCompare(b.label)
    const sorted = [...groups].sort(byKey).map((g) => ({ ...g, children: [...g.children].sort(byKey) }))
    const q = fold(query.trim())
    const filtered = q ? sorted.filter((g) => fold(g.label).includes(q)) : sorted
    const cut = q || topN >= filtered.length ? filtered : filtered.slice(0, topN)
    const rest = filtered.slice(cut.length)
    return {
      visible: cut,
      otras: rest.length > 0 ? sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`) : null,
      total: filtered.length,
    }
  }, [groups, effectiveSort, query, topN])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }))

  const toggleExpanded = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const expandableKeys = visible.filter((g) => g.children.length > 1).map((g) => g.key)
  const allExpanded = expandableKeys.length > 0 && expandableKeys.every((k) => expanded.has(k))
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(expandableKeys))

  // ── Drills: cada número abre sus registros ────────────────────────────────
  const oppsOf = (ids: string[]) => ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => !!o)
  const contactsOf = (ids: string[]) => ids.map((id) => contactById.get(id)).filter((c): c is Contact => !!c)
  const drillOpps = (row: PaidRow, title: string, ids: string[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle: subtitle ?? row.label, opportunities: oppsOf(ids) })
  const drillContacts = (row: PaidRow, title: string) =>
    onDrill({ open: true, title, subtitle: row.label, opportunities: [], contactItems: contactsOf(row.contactIds) })
  const drillAppointments = (row: PaidRow, title: string, onlyShowed: boolean) => {
    const set = new Set(row.apptContactIds)
    // Las opps de la fila cuyos contactos tienen cita; un contacto con cita y sin
    // opp en la ventana se resuelve contra el historial, como todo drawer.
    const inRow = oppsOf(row.oppIds).filter((o) => set.has(o.contactId))
    const seen = new Set(inRow.map((o) => o.contactId))
    const fromHistory = allOpportunities.filter((o) => set.has(o.contactId) && !seen.has(o.contactId))
    onDrill({ open: true, title, subtitle: `${row.label}${onlyShowed ? " · contactos con cita efectiva" : ""}`, opportunities: [...inRow, ...fromHistory] })
  }

  // ── Celdas ────────────────────────────────────────────────────────────────
  const cellMoney = (n: number | null, currency: string | null) =>
    n === null ? "—" : money(n, tableCurrency ? "?" : (currency ?? "?"))
  const colLabel = (c: (typeof PAID_COLUMNS)[number]) =>
    tableCurrency && MONEY_COLS.has(c.id) ? `${c.label} (${tableCurrency})` : c.label

  const numericCols = PAID_COLUMNS.filter((c) => visibleCols.has(c.id) && c.id !== "stages")
  const showStages = visibleCols.has("stages")

  const numberButton = (label: string, onClick: () => void) => (
    <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); onClick() }}>{label}</button>
  )

  const renderCell = (row: PaidRow, col: PaidColumnId, isOtras: boolean): ReactNode => {
    const suppressed = costsSuppressed && (col === "cpl" || col === "cpa")
    switch (col) {
      case "spend": return cellMoney(row.spend, row.currency)
      case "cpm": return isOtras ? "—" : cellMoney(row.cpm, row.currency)
      case "cpl": return isOtras || suppressed ? "—" : cellMoney(row.cpl, row.currency)
      case "cpa": return isOtras || suppressed ? "—" : cellMoney(row.cpa, row.currency)
      case "ctr": return isOtras ? "—" : pct(row.ctr)
      case "impressions": return int(row.impressions)
      case "clicks": return int(row.clicks)
      case "leadsMeta": return int(row.leadsMeta)
      case "leadsCrm": return numberButton(int(row.leadsCrm), () => drillContacts(row, "Leads del CRM"))
      case "opportunities": return numberButton(int(row.opportunities), () => drillOpps(row, "Oportunidades", row.oppIds))
      case "won": return numberButton(int(row.won), () => drillOpps(row, "Ganadas", oppsOf(row.oppIds).filter(isWonOpp).map((o) => o.id)))
      case "appointments": return numberButton(int(row.appointments), () => drillAppointments(row, "Contactos con cita", false))
      case "showed": return numberButton(int(row.showed), () => drillAppointments(row, "Citas efectivas", true))
      case "stages":
        return (
          <StageBar
            stages={row.stages}
            onSegmentClick={(s) => drillOpps(row, s.stage, oppsOf(row.oppIds).filter((o) => o.stage === s.stage).map((o) => o.id), `${row.label} · ${s.count} en ${s.stage}`)}
          />
        )
    }
  }

  const renderName = (row: PaidRow, { isChild, isOtras, expandable, isOpen }: RowOpts) => (
    <TableCell className={`max-w-[28rem] ${isChild ? "pl-9" : "font-medium"} ${isOtras ? "text-muted-foreground" : ""}`}>
      <div className="flex items-center gap-1.5">
        {!isChild && !isOtras && (
          expandable
            ? <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); toggleExpanded(row.key) }} aria-label={isOpen ? "Colapsar" : "Expandir"}>
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            : <span className="inline-block w-[18px] shrink-0" />
        )}
        {isChild ? (
          row.adId ? (
            <span className="inline-flex items-center font-mono text-xs">{row.adId}<CopyButton value={row.adId} /></span>
          ) : (
            <span className="italic text-muted-foreground">{row.label}</span>
          )
        ) : (
          <span className="truncate" title={row.label}>{row.label}</span>
        )}
        {!isChild && !isOtras && row.adId && (
          <span className="ml-1 inline-flex items-center font-mono text-[11px] text-muted-foreground">{row.adId}<CopyButton value={row.adId} /></span>
        )}
        {/* La liga es del anuncio: en un grupo con varios anuncios se ve al expandir,
            no aquí, donde solo taparía el nombre de la campaña. */}
        {row.url && (isChild || !expandable) && (
          <span className="ml-2 inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {row.url.platform === "facebook" ? <Facebook className="h-3 w-3 text-[#1877F2]" /> : row.url.platform === "instagram" ? <Instagram className="h-3 w-3 text-[#E1306C]" /> : <Link2 className="h-3 w-3" />}
            <span className="font-mono">{shortUrl(row.url.href)}</span>
            {row.url.others > 0 && <span>+{row.url.others}</span>}
            <LinkButton value={row.url.href} />
          </span>
        )}
        {!isChild && !isOtras && row.crmOnly && showMeta && (
          <span className="ml-1 shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">sin Meta</span>
        )}
      </div>
    </TableCell>
  )

  const renderRow = (row: PaidRow, opts: RowOpts) => (
    <TableRow
      key={(opts.isChild ? "c:" : "g:") + row.key}
      className={`cursor-pointer ${opts.isChild ? "bg-muted/20 text-[13px]" : ""} ${opts.isOtras ? "text-muted-foreground" : ""}`}
      onClick={() => drillOpps(row, "Oportunidades", row.oppIds)}
    >
      {renderName(row, opts)}
      {numericCols.map((c) => (
        <TableCell key={c.id} className="whitespace-nowrap text-right tabular-nums">{renderCell(row, c.id, opts.isOtras)}</TableCell>
      ))}
      {showStages && <TableCell className="min-w-[10rem]">{renderCell(row, "stages", opts.isOtras)}</TableCell>}
    </TableRow>
  )

  const scopeLabel = costsSuppressed && showMeta ? "sin costos con filtros" : groupBy === "platform" && hasMeta ? "sin gasto por origen" : hasMeta ? "cohorte por fecha" : "sin Meta"
  const scopeTooltip = (
    <>
      {metaInv ? metaScopeNote(metaInv, status) : "Pautas del CRM en la ventana (Meta, TikTok, Google), agrupadas por su anuncio. Conecta Meta desde el header para ver gasto, CPL y CPA."}
      {groupBy === "platform" && hasMeta && " En modo Origen no hay gasto: un anuncio produce oportunidades de varios orígenes y repartirlo sería inventar."}
      {" Citas cuenta contactos con al menos una cita en la ventana; Efectivas, con una cita realizada."}
    </>
  )

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión y rendimiento de pauta"
        icon={Coins}
        total={groups.reduce((a, g) => a + g.opportunities, 0)}
        actions={<ScopePill label={scopeLabel} tooltip={scopeTooltip} />}
      />

      {metaInv && groupBy === "campaign" && <MetaInvestmentTiles inv={metaInv} onDrill={onDrill} />}

      <div id="meta-campaign-table" className="mt-5 flex flex-wrap items-center gap-3">
        <SegmentedToggle value={groupBy} options={[{ v: "campaign", label: "Campaña" }, { v: "platform", label: "Origen" }]} onChange={onGroupByChange} />
        <label className="relative inline-flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={groupBy === "campaign" ? "Buscar campaña…" : "Buscar origen…"}
            className="h-7 w-44 rounded-md border border-border/60 bg-transparent pl-7 pr-2 text-xs outline-none focus:border-primary/60"
          />
        </label>
        <TopNSlider value={topN} max={groups.length} onChange={setTopN} disabled={query.trim().length > 0} />
        <SwitchButton label="Perdidas" on={includeLost} onChange={onIncludeLostChange} />
        <button
          type="button"
          onClick={toggleAll}
          disabled={expandableKeys.length === 0}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
          title={allExpanded ? "Colapsar todo" : "Expandir todo"}
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
          {allExpanded ? "Colapsar" : "Expandir"}
        </button>
        <ColumnEditor showMeta={showMeta} value={visibleCols} onChange={setVisibleCols} />
      </div>

      {groups.length === 0 ? (
        <ChartEmpty message="Sin oportunidades de pauta en la ventana." height={160} />
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[20rem]">{groupBy === "campaign" ? "Campaña / anuncio" : "Origen / anuncio"}</TableHead>
                  {numericCols.map((c) => (
                    <TableHead key={c.id} className="whitespace-nowrap text-right">
                      <button type="button" onClick={() => toggleSort(c.id as SortKey)} className={`inline-flex items-center gap-1 hover:text-foreground ${effectiveSort.key === c.id ? "text-foreground" : ""}`}>
                        {colLabel(c)}
                        {effectiveSort.key === c.id && <span aria-hidden>{effectiveSort.dir === "desc" ? "↓" : "↑"}</span>}
                      </button>
                    </TableHead>
                  ))}
                  {showStages && <TableHead>Etapas</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((g) => {
                  const expandable = g.children.length > 1
                  const isOpen = expandable && expanded.has(g.key)
                  // Un grupo con un solo hijo muestra el ID y la URL de ese hijo en su fila.
                  const only = !expandable ? g.children[0] : undefined
                  const shown: PaidRow = only ? { ...g, adId: only.adId, url: only.url } : g
                  return [
                    renderRow(shown, { isChild: false, isOtras: false, expandable, isOpen }),
                    ...(isOpen ? g.children.map((c) => renderRow(c, { isChild: true, isOtras: false, expandable: false, isOpen: false })) : []),
                  ]
                })}
                {otras && renderRow(otras, { isChild: false, isOtras: true, expandable: false, isOpen: false })}
              </TableBody>
            </Table>
          </div>
          <ChartHint>
            {`${total} ${groupBy === "campaign" ? "campañas" : "orígenes"}${query ? ` que contienen "${query.trim()}"` : topN < total ? ` · top ${topN}` : ""} · clic en una fila para ver sus oportunidades · expande una campaña para ver sus anuncios`}
          </ChartHint>
        </>
      )}
    </DashboardCard>
  )
}

// ── PDF ─────────────────────────────────────────────────────────────────────
// La misma tabla, en bloques de pdfmake: top 15 grupos con las columnas de
// pantalla (sin Impr./Clics/CPM, que en papel solo ensanchan), y una tabla
// anexa etapa × campaña — una tabla se lee en papel; una apilada de 30
// colores no.

export function buildPaidReportSection(p: {
  groups: PaidGroup[]
  groupBy: PaidGroupBy
  hasMeta: boolean
  costsSuppressed: boolean
  includeLost: boolean
}): ReportSection {
  const showMeta = p.hasMeta && p.groupBy === "campaign"
  const sorted = [...p.groups].sort((a, b) =>
    showMeta ? (b.spend ?? 0) - (a.spend ?? 0) || b.opportunities - a.opportunities : b.opportunities - a.opportunities || (b.spend ?? 0) - (a.spend ?? 0)
  )
  const top = sorted.slice(0, 15)
  const rest = sorted.slice(15)
  const currencies = new Set(top.map((g) => g.currency).filter((c): c is string => !!c && c !== "?"))
  const tc = currencies.size === 1 ? Array.from(currencies)[0] : null
  const cell = (n: number | null, c: string | null) => (n === null ? "—" : money(n, tc ? "?" : (c ?? "?")))
  const suppressed = p.costsSuppressed
  const noun = p.groupBy === "campaign" ? "Campaña" : "Origen"
  const withCurrency = (label: string) => (tc ? `${label} (${tc})` : label)

  const headers = [
    noun,
    ...(showMeta ? [withCurrency("Gasto"), "CTR", "Leads Meta"] : []),
    "Leads CRM", "Opps", "Ganadas",
    ...(showMeta ? [withCurrency("CPL"), withCurrency("CPA")] : []),
    "Citas", "Efectivas",
  ]
  const rowOf = (g: PaidRow, isOtras = false): string[] => [
    g.label,
    ...(showMeta ? [cell(g.spend, g.currency), isOtras ? "—" : pct(g.ctr), int(g.leadsMeta)] : []),
    int(g.leadsCrm), int(g.opportunities), int(g.won),
    ...(showMeta ? [suppressed || isOtras ? "—" : cell(g.cpl, g.currency), suppressed || isOtras ? "—" : cell(g.cpa, g.currency)] : []),
    int(g.appointments), int(g.showed),
  ]
  const rows = top.map((g) => rowOf(g))
  if (rest.length > 0) rows.push(rowOf(sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`), true))

  // Etapa × campaña: top 6 por opps + Otras.
  const byOpps = [...p.groups].sort((a, b) => b.opportunities - a.opportunities)
  const stageCols = byOpps.slice(0, 6)
  const stageRest = byOpps.slice(6)
  const stageColRows: PaidRow[] = stageRest.length > 0 ? [...stageCols, sumRows(stageRest, OTRAS_KEY, `Otras (${stageRest.length})`)] : stageCols
  const stageNames = Array.from(new Map(p.groups.flatMap((g) => g.stages).map((s) => [s.stage, s])).values())
    .sort((x, y) => Number(x.lost) - Number(y.lost) || x.order - y.order || x.stage.localeCompare(y.stage))
    .map((s) => s.stage)
  const stageTable = {
    t: "table" as const,
    headers: ["Etapa", ...stageColRows.map((g) => g.label)],
    rows: stageNames.map((name) => [name, ...stageColRows.map((g) => int(g.stages.find((s) => s.stage === name)?.count ?? 0))]),
  }

  return {
    id: "pauta-rendimiento",
    title: "Inversión y rendimiento de pauta",
    explanation:
      (showMeta
        ? "Gasto de Meta Ads en el periodo, cruzado por id de anuncio con los contactos y oportunidades de pauta del CRM creados en él (oportunidad → objeto Pauta → primera atribución → última). Leads CRM son contactos; CPL usa esos leads, no los que Meta reporta; CPA usa las oportunidades ganadas. "
        : "Pautas del CRM en el periodo (Meta, TikTok, Google), agrupadas por su anuncio; sin conexión a Meta no hay gasto. ") +
      "Citas cuenta contactos con al menos una cita en el periodo; Efectivas, con una cita realizada. La tabla de etapas muestra en qué punto del pipeline están las oportunidades de cada " +
      (p.groupBy === "campaign" ? "campaña" : "origen") +
      (p.includeLost ? ", perdidas incluidas." : "; las perdidas no se cuentan.") +
      (suppressed && showMeta ? " Con filtros de atributo activos el gasto no se recorta, por eso CPL y CPA no se calculan." : ""),
    blocks: [
      { t: "table", headers, rows },
      { t: "subheading", text: `Oportunidades de pauta por etapa${p.includeLost ? "" : " (sin perdidas)"}` },
      stageTable,
    ],
  }
}
