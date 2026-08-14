"use client"

import { useState, useCallback, useMemo } from "react"
import {
  Bar,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
  Legend,
  LabelList,
  PieChart,
  Pie,
  Sector,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import type { Opportunity, Contact, Pauta, Task, Call, Appointment, Pipeline } from "@/lib/types"
import { Tag, FileText, Calendar, BarChart3, Layers, TrendingUp, TrendingDown, Facebook, Instagram, Copy, Check, ExternalLink } from "lucide-react"
import { PLATFORM_COLORS, PLATFORM_ORDER, platformLabel, originSignalText, hasGoogleAdsSignal, hasWebsiteSignal } from "@/lib/source-platform"
import {
  isPaidTraffic,
  isDePauta as isDePautaOpp,
  resolveCampaignName,
  buildPautaNameByContact,
  PAID_SOCIAL_SOURCES,
  PAID_SOCIAL_MEDIUMS,
  PAID_SEARCH_SOURCES,
  PAID_SEARCH_MEDIUMS,
} from "@/lib/pauta"
import { isWonOpp } from "@/lib/opportunity-status"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { CampaignActivityChart } from "./campaign-activity-chart"
import { ExportReportButton } from "./export-report-button"
import type { ReportInput, ReportSection } from "@/lib/report"
import { OrigenDeLeadInfo } from "./origen-de-lead-criteria"
import {
  BRAND_AMBER,
  CHART_PALETTE,
  CHART_GRID_STROKE,
  CHART_TICK,
  chartPaletteColor,
  DashboardShell,
  DashboardCard,
  ChartCardHeader,
  ScopePill,
  ChartCardContent,
  ChartEmpty,
  ChartHint,
  MarketingSummaryStrip,
  NonZeroTooltipContent,
  PlatformIcon,
} from "./dashboard-ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// Spanish labels for raw GHL appointment statuses.
const APPT_STATUS_LABELS: Record<string, string> = {
  showed: "Asistió",
  confirmed: "Confirmada",
  new: "Pendiente",
  noshow: "No asistió",
  cancelled: "Cancelada",
  invalid: "Inválida",
}

const apptStatusLabel = (s: string) => APPT_STATUS_LABELS[s] ?? s

interface MarketingDashboardProps {
  opportunities: Opportunity[]
  /**
   * Full, date-unfiltered opportunity set, used only as a lookup table when the
   * drill-down drawer resolves a contact's linked opportunity. An opportunity
   * can be created before (or after) the pauta/contact that lands it in the
   * active window, so the date filter may drop it from `opportunities` even
   * while its contact is on screen — resolving the join against the filtered
   * slice would then wrongly show "Sin oportunidad". Charts/KPIs still use the
   * date-filtered `opportunities`. Defaults to `opportunities`.
   */
  allOpportunities?: Opportunity[]
  contacts: Contact[]
  /**
   * Full, date-unfiltered contact set, used only as a lookup table when the
   * drill-down drawer resolves an opportunity's linked contact. A contact can
   * be created before its opportunity, so the date filter may drop it from
   * `contacts` even while the opportunity is in range — resolving the join
   * against the filtered slice would then show "Contacto no encontrado".
   * Charts/KPIs still use the date-filtered `contacts`. Defaults to `contacts`.
   */
  allContacts?: Contact[]
  pautas: Pauta[]
  /**
   * Full, date-unfiltered pauta set. A pauta's "reingreso" rank is its position
   * in *its contact's entire* pauta history (2nd, 3rd, … entry), so the ranking
   * must be computed against every pauta the contact has — not just the ones in
   * the active date window. Ranking against the filtered slice would relabel a
   * contact's earlier-than-window first pauta out of view, wrongly counting its
   * in-window follow-up as a "Primer ingreso". Counts/charts still only *show*
   * pautas from the filtered `pautas`. Defaults to `pautas`.
   */
  allPautas?: Pauta[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  appointments?: Appointment[]
  /**
   * Full, date-unfiltered appointment set, used only as a lookup table when the
   * detail drawer resolves a contact's "Citas". A cita can be scheduled outside
   * the active window that lands its contact on screen, so the date filter may
   * drop it from `appointments` even while its contact is shown — resolving the
   * join against the filtered slice would then wrongly say "Sin citas
   * registradas". Charts still use the date-filtered `appointments`. Defaults to
   * `appointments`.
   */
  allAppointments?: Appointment[]
  locationId?: string
  /** Sub-account name, used in the exported report's filename. */
  locationName?: string
  /** Label of the active global date filter, shown on the PDF report cover. */
  periodLabel?: string
  /** Resumen de los filtros de atributo activos, si los hay. */
  filtersLabel?: string
}

// Normalize any createdAt format → "YYYY-MM-DD" (UTC). Handles ISO strings,
// Unix-ms numbers, numeric strings, and null/undefined.
function toUTCDateStr(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === "") return ""
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10)
  const num = typeof val === "number" ? val : /^\d{10,}$/.test(val) ? Number(val) : NaN
  const d = new Date(isNaN(num) ? (val as string) : num)
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

// CHART_PALETTE imported from dashboard-ui (amber-led)

// PLATFORM_COLORS / PLATFORM_ORDER / platformLabel are shared with the Ventas
// dashboard via lib/source-platform.ts; PlatformIcon lives in dashboard-ui.

const REINGRESO_LABELS = [
  "Primer ingreso",
  "Segundo reingreso",
  "Tercer reingreso",
  "Cuarto reingreso",
  "5to+ reingreso",
]

const REINGRESO_COLORS: Record<string, string> = {
  "Primer ingreso":    "#3b82f6",
  "Segundo reingreso": "#f59e0b",
  "Tercer reingreso":  "#10b981",
  "Cuarto reingreso":  "#8b5cf6",
  "5to+ reingreso":    "#ef4444",
}

function reingresoLabel(zeroBasedIndex: number): string {
  return REINGRESO_LABELS[Math.min(zeroBasedIndex, REINGRESO_LABELS.length - 1)]
}


const SOCIAL_ORGANIC_SOURCES = ["instagram", "facebook", "twitter", "linkedin", "youtube", "tiktok", "pinterest", "social_media", "social media", "organic_social"]

const SOURCE_CATEGORY_ORDER = ["Paid Social", "Paid Search", "Social Media", "CRM UI", "Orgánico Web", "Otro"]
const SOURCE_CATEGORY_COLORS: Record<string, string> = {
  "Paid Social":   "#3b82f6",
  "Paid Search":   "#0891b2",
  "Social Media":  "#8b5cf6",
  "CRM UI":        "#f59e0b",
  "Orgánico Web":  "#10b981",
  "Otro":          "#6b7280",
}

// Friendly, Spanish display names for the source categories. The keys above stay
// as the internal data-key/identity (they're generated by sourceCategory() and
// used as Recharts dataKeys); this map is applied only at render time so charts,
// legends, tooltips and drill titles read plainly for non-marketers.
const SOURCE_CATEGORY_LABELS: Record<string, string> = {
  "Paid Social": "Publicidad en Meta/TikTok",
  "Paid Search": "Publicidad en Google",
  "Social Media": "Redes Sociales (Orgánico)",
  "CRM UI": "Manual (CRM)",
}
const catLabel = (cat: string): string => SOURCE_CATEGORY_LABELS[cat] ?? cat

// Manually-created leads carry the CRM-UI fingerprint in the attribution, NOT
// in `source`: GHL sets utmSessionSource="CRM UI" (→ adType) and medium="manual"
// (→ attributionMedium). Detect any of those so hand-entered leads land in the
// "CRM UI" bucket instead of falling through to "Otro".
const CRM_UI_VALUES = ["crm ui", "crm", "manual"]
function isCrmUi(src: string, med: string, attrMed: string): boolean {
  return (
    CRM_UI_VALUES.includes(src) ||
    CRM_UI_VALUES.includes(med) ||
    CRM_UI_VALUES.includes(attrMed)
  )
}

function sourceCategory(opp: Opportunity): string {
  const src = (opp.source ?? "").toLowerCase()
  const med = (opp.adType ?? "").toLowerCase()
  const attrMed = (opp.attributionMedium ?? "").toLowerCase()
  // Website leads arrive without a UTM platform (pushed in via Zapier →
  // source/medium look like "Third Party"/"zapier"); the surviving signal lives
  // in the opportunity custom fields. Distinguish paid vs organic website:
  //   • "Tipo de pauta = Google Ads"            → Paid Search (paid website lead)
  //   • website "Origen de Lead" with NO pauta  → Orgánico Web (organic website lead)
  const originSignal = originSignalText(opp)
  if (hasGoogleAdsSignal(originSignal)) return "Paid Search"
  if (PAID_SOCIAL_SOURCES.some((s) => src.includes(s)) || PAID_SOCIAL_MEDIUMS.some((m) => med.includes(m))) return "Paid Social"
  if (PAID_SEARCH_SOURCES.some((s) => src.includes(s)) || PAID_SEARCH_MEDIUMS.some((m) => med.includes(m))) return "Paid Search"
  if (SOCIAL_ORGANIC_SOURCES.some((s) => src.includes(s)) || med.includes("social")) return "Social Media"
  // Organic website origin — checked before the empty-source CRM-UI catch below,
  // since these leads also have a blank source/medium.
  if (hasWebsiteSignal(originSignal)) return "Orgánico Web"
  if (src === "" || med === "" || isCrmUi(src, med, attrMed)) return "CRM UI"
  if (src.includes("web") || src.includes("website") || src.includes("landing") || med === "organic" || med === "referral") return "Orgánico Web"
  return "Otro"
}

// Landing URLs in this location are the social links themselves:
// instagram.com/p/… (Instagram) and fb.me/… (Facebook).
function urlPlatform(url: string): "facebook" | "instagram" | null {
  const u = url.toLowerCase()
  if (u.includes("instagram.com")) return "instagram"
  if (u.includes("fb.me") || u.includes("facebook.com") || u.includes("fb.com")) return "facebook"
  return null
}

// Show a compact label for a social URL (the path slug) while keeping the
// full URL available via title for the tooltip.
function shortUrlLabel(raw: string): string {
  try {
    const u = new URL(raw)
    const slug = u.pathname.replace(/\/$/, "").split("/").pop() || u.hostname
    return slug.length > 22 ? slug.slice(0, 22) + "…" : slug
  } catch {
    return raw.length > 22 ? raw.slice(0, 22) + "…" : raw
  }
}

function paidTrafficUrlLabel(url: string): string {
  const platform = urlPlatform(url)
  const prefix = platform === "facebook" ? "FB - " : platform === "instagram" ? "IG - " : ""
  try {
    const u = new URL(url)
    const slug = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).pop() || u.hostname
    const truncated = slug.length > 22 ? slug.slice(0, 22) + "…" : slug
    return prefix + truncated
  } catch {
    const truncated = url.length > 22 ? url.slice(0, 22) + "…" : url
    return prefix + truncated
  }
}

// Contact-side counterpart of platformLabel(opp): map a contact's attribution
// to the social platform it originated from. GHL stores the click-through URL
// on each attribution (instagram.com/…, fb.me/…, tiktok.com/…); unknown/absent
// signals fall back to "Otro".
function platformFromContact(c?: Contact): string {
  const url = (c?.attributionUrl ?? "").toLowerCase()
  const src = (c?.source ?? "").toLowerCase()
  if (url.includes("instagram.com") || src.includes("instagram")) return "Instagram"
  if (
    url.includes("fb.me") || url.includes("facebook.com") || url.includes("fb.com") ||
    src.includes("facebook") || src.includes("meta") || src === "fb" ||
    /^\d{10,}$/.test(c?.source ?? "")
  ) return "Facebook"
  if (url.includes("tiktok") || src.includes("tiktok")) return "TikTok"
  if (src.includes("google") || src.includes("bing") || src.includes("yahoo")) return "Google"
  // WhatsApp is a contact channel, not a lead origin — see platformLabel() in
  // lib/source-platform.ts. WhatsApp-attributed contacts fall through to "Otro".
  return "Otro"
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="ml-1.5 inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      title={`Copiar: ${value}`}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function LinkButton({ value }: { value: string }) {
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className="ml-1.5 inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      title={value}
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

type PaidGroupBy = "campaign" | "url" | "id" | "platform"

const PAID_GROUP_OPTIONS: { v: PaidGroupBy; label: string }[] = [
  { v: "campaign", label: "Campaña" },
  { v: "url", label: "URL" },
  { v: "id", label: "ID" },
  { v: "platform", label: "Origen" },
]

// Subset used by charts that only make sense split two ways (campaign vs origin),
// e.g. the lost-reasons stack — high-cardinality URL/ID modes don't apply there.
const CAMPAIGN_ORIGIN_OPTIONS: { v: PaidGroupBy; label: string }[] = [
  { v: "campaign", label: "Campaña" },
  { v: "platform", label: "Origen" },
]

function GroupByToggle({
  value,
  onChange,
  options = PAID_GROUP_OPTIONS,
}: {
  value: PaidGroupBy
  onChange: (v: PaidGroupBy) => void
  options?: { v: PaidGroupBy; label: string }[]
}) {
  return (
    <div className="flex items-center overflow-hidden rounded border border-border/50 text-[10px] font-medium">
      {options.map((opt, i) => (
        <button
          key={opt.v}
          onClick={(e) => { e.stopPropagation(); onChange(opt.v) }}
          className={[
            "px-2 py-0.5 transition-colors uppercase tracking-wide",
            i > 0 ? "border-l border-border/50" : "",
            value === opt.v
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/30",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Prose form of the active grouping, for the PDF report's per-chart explanation
// ("dividida por campaña" / "por anuncio"), so the text tracks the toggle.
function paidGroupByNoun(groupBy: PaidGroupBy): string {
  if (groupBy === "platform") return "plataforma de origen"
  if (groupBy === "url") return "URL de atribución"
  if (groupBy === "id") return "ID de anuncio"
  return "campaña"
}

// Campaign-name resolution (opp campaignName → "Nombre pauta" custom field →
// utmContent → first Pauta record) lives in lib/pauta (resolveCampaignName), shared
// with the AI tools.
function paidGroupByKey(
  opp: Opportunity,
  groupBy: PaidGroupBy,
  pautaNameByContact?: Map<string, string>
): string | null | undefined {
  if (groupBy === "platform") return platformLabel(opp)
  if (groupBy === "url") return opp.attributionUrl
  if (groupBy === "campaign") return resolveCampaignName(opp, pautaNameByContact)
  return opp.adId
}

// Campaign names in an account usually share a long boilerplate prefix
// (e.g. "IW - CC - FF - Corregidora - ") and differ only by a suffix such as the
// month. Grouping by campaign would then render visually identical bars. Given a
// chart's set of campaign keys, return the length of the run shared by every key
// (trimmed to a separator boundary) so labels can drop it. Returns 0 for
// non-campaign modes or when there's nothing meaningful to strip.
function campaignPrefixCut(keys: string[], groupBy: PaidGroupBy): number {
  if (groupBy !== "campaign" || keys.length < 2) return 0
  let prefix = keys[0] ?? ""
  for (const k of keys) {
    let i = 0
    while (i < prefix.length && i < k.length && prefix[i] === k[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) return 0
  }
  // Cut on the last separator so we never slice mid-word.
  const cut = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("-")) + 1
  return cut > 3 ? cut : 0
}

function paidGroupByLabel(key: string, groupBy: PaidGroupBy, prefixCut = 0): string {
  if (groupBy === "url") return paidTrafficUrlLabel(key)
  if (groupBy === "campaign") {
    const rest = (prefixCut > 0 ? key.slice(prefixCut) : key).trim() || key
    return rest.length > 30 ? rest.slice(0, 30) + "…" : rest
  }
  return key
}

function paidGroupByHint(groupBy: PaidGroupBy): string {
  if (groupBy === "url") return "URL de atribución"
  if (groupBy === "id") return "ID de anuncio"
  if (groupBy === "campaign") return "campaña"
  return "plataforma de origen"
}

type OriginGroupBy = "platform" | "id" | "url"

const ORIGIN_GROUP_OPTIONS: { value: OriginGroupBy; label: string; column: string }[] = [
  { value: "platform", label: "Origen", column: "Plataforma" },
  { value: "id",       label: "ID",   column: "ID de Pauta" },
  { value: "url",      label: "URL",  column: "URL de Pauta" },
]

function OriginGroupByToggle({ value, onChange }: { value: OriginGroupBy; onChange: (v: OriginGroupBy) => void }) {
  return (
    <div className="flex items-center overflow-hidden rounded border border-border/50 text-[10px] font-medium">
      {ORIGIN_GROUP_OPTIONS.map((opt, i) => (
        <button
          key={opt.value}
          onClick={(e) => { e.stopPropagation(); onChange(opt.value) }}
          className={[
            "px-2 py-0.5 transition-colors uppercase tracking-wide",
            i > 0 ? "border-l border-border/50" : "",
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/30",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function TopNSlider({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  const effectiveValue = Math.min(value, max)
  const isAll = effectiveValue >= max
  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <span className="text-[10px] font-medium text-muted-foreground tabular-nums w-12 text-right shrink-0">
        {isAll ? "Todo" : `Top ${effectiveValue}`}
      </span>
      <input
        type="range"
        min={1}
        max={max || 1}
        value={effectiveValue}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-20 cursor-pointer accent-primary"
      />
    </div>
  )
}

export function MarketingDashboard({ opportunities, allOpportunities, contacts, allContacts, pautas, allPautas, pipelines = [], tasks = [], calls = [], appointments = [], allAppointments, locationId = "", locationName, periodLabel, filtersLabel }: MarketingDashboardProps) {
  // Lookup table for drawer contact-resolution: the full set when provided,
  // falling back to the date-filtered `contacts` for backward compatibility.
  const lookupContacts = allContacts ?? contacts
  // Lookup table for drawer opportunity-resolution: the full set when provided,
  // falling back to the date-filtered `opportunities` for backward compatibility.
  const lookupOpportunities = allOpportunities ?? opportunities
  // Lookup table for the detail drawer's "Citas": the full set when provided,
  // falling back to the date-filtered `appointments` for backward compatibility.
  const lookupAppointments = allAppointments ?? appointments
  // Reingreso ranking must see every pauta of each contact, not just the ones in
  // the active date window — fall back to the filtered set when not provided.
  const rankingPautas = allPautas ?? pautas
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const [hoveredAdType, setHoveredAdType] = useState<number | undefined>(undefined)
  const [apptGroupBy, setApptGroupBy] = useState<PaidGroupBy>("campaign")
  const [wonGroupBy, setWonGroupBy] = useState<PaidGroupBy>("campaign")
  const [stageGroupBy, setStageGroupBy] = useState<PaidGroupBy>("campaign")
  const [lostGroupBy, setLostGroupBy] = useState<PaidGroupBy>("campaign")
  const [originGroupBy, setOriginGroupBy] = useState<OriginGroupBy>("platform")
  const [onlyReingresos, setOnlyReingresos] = useState(false)
  const [stageIncludeLost, setStageIncludeLost] = useState(true)
  const [pautaUniqueLeads, setPautaUniqueLeads] = useState(false)
  const [stageTopN, setStageTopN] = useState(30)
  const [lostTopN, setLostTopN] = useState(Infinity)
  const [apptTopN, setApptTopN] = useState(Infinity)
  const [wonTopN, setWonTopN] = useState(Infinity)
  const [apptStatusFilter, setApptStatusFilter] = useState<string>("all")

  const openDrill = useCallback((title: string, items: Opportunity[], subtitle?: string) => {
    setDrill({ open: true, title, subtitle, opportunities: items })
  }, [])

  // Map pauta.id → reingresoLabel by ranking each contact's pautas chronologically
  // over their FULL (unfiltered) history. Defined early because both the pauta
  // channel chart and its drill-down need it. The map keys every pauta id, so
  // lookups from the date-filtered slice still resolve.
  const pautaReingresoMap = useMemo(() => {
    const byContact = new Map<string, Pauta[]>()
    for (const p of rankingPautas) {
      if (!p.contactId) continue
      const arr = byContact.get(p.contactId) ?? []
      arr.push(p)
      byContact.set(p.contactId, arr)
    }
    const result = new Map<string, string>()
    for (const arr of byContact.values()) {
      arr.sort((a, b) => toUTCDateStr(a.createdAt).localeCompare(toUTCDateStr(b.createdAt)))
      arr.forEach((p, i) => result.set(p.id, reingresoLabel(i)))
    }
    return result
  }, [rankingPautas])

  // A pauta is a "unique lead" when it's the contact's first-ever pauta (rank 0);
  // its later pautas are reingresos, not new leads. This is the definition behind
  // the "Leads únicos" KPI (= pautas − reingresos).
  const isUniqueLead = useCallback(
    (p: Pauta) => (pautaReingresoMap.get(p.id) ?? "Primer ingreso") === "Primer ingreso",
    [pautaReingresoMap]
  )

  // Every contact id that has at least one Pauta custom-object record, over the
  // FULL (unfiltered) pauta history — a pauta created outside the active date
  // window still proves its contact arrived through paid advertising.
  const pautaContactIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of rankingPautas) if (p.contactId) s.add(p.contactId)
    return s
  }, [rankingPautas])

  // contactId → the name of the contact's FIRST named Pauta record. Last-resort
  // fallback for resolveCampaignName (shared with the AI tools via lib/pauta).
  const pautaNameByContact = useMemo(() => buildPautaNameByContact(rankingPautas), [rankingPautas])

  // Canonical "es de pauta" predicate for every "por pauta" chart — the union of
  // "contact linked to a Pauta record" and isPaidTraffic. Shared with the AI tools
  // via lib/pauta (isDePautaOpp); see that module for the full rationale.
  const isDePauta = useCallback(
    (opp: Opportunity) => isDePautaOpp(opp, pautaContactIds),
    [pautaContactIds]
  )

  // Derive ordered stage list using GHL pipeline order; fall back to alphabetical for unlisted stages
  const stageOrder = useMemo(() => {
    const actual = new Set(opportunities.map((o) => o.stage))
    const ordered: string[] = []
    // Walk pipelines in their GHL-defined stage order
    for (const p of pipelines) {
      for (const s of p.stages) {
        if (actual.has(s) && !ordered.includes(s)) ordered.push(s)
      }
    }
    // Append any stages present in data but not covered by pipeline definitions
    for (const s of actual) if (!ordered.includes(s)) ordered.push(s)
    return ordered
  }, [opportunities, pipelines])

  // Leads por Plataforma — ALL opportunities, stacked by source category
  const leadsByCategory = useMemo(() => {
    // platform → sourceCategory → count
    const platMap = new Map<string, Map<string, number>>()
    for (const o of opportunities) {
      const plat = platformLabel(o)
      const cat = sourceCategory(o)
      if (!platMap.has(plat)) platMap.set(plat, new Map())
      const catCounts = platMap.get(plat)!
      catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1)
    }
    return Array.from(platMap.entries())
      .map(([platform, catCounts]) => {
        const breakdown = SOURCE_CATEGORY_ORDER
          .filter((cat) => catCounts.has(cat))
          .map((cat) => ({ category: cat, count: catCounts.get(cat)!, color: SOURCE_CATEGORY_COLORS[cat] ?? "#6b7280" }))
        const total = breakdown.reduce((s, e) => s + e.count, 0)
        return { platform, total, color: PLATFORM_COLORS[platform] ?? "#6b7280", breakdown }
      })
      .sort((a, b) => b.total - a.total)
  }, [opportunities])

  // Built from the UNFILTERED contacts: a pauta inside the date range can belong
  // to a contact created before it. Looking that contact up in the date-filtered
  // set would miss it and mis-bucket the pauta's platform as "Otro".
  const contactById = useMemo(() => {
    const m = new Map<string, Contact>()
    for (const c of lookupContacts) m.set(c.id, c)
    return m
  }, [lookupContacts])

  // Drill to the leads behind a set of pautas. Resolving to opportunities here
  // would drastically undercount, since most pauta contacts never become
  // opportunities — the drawer count must track the bar's count. Resolve against
  // lookupContacts (via contactById), NOT the date-filtered `contacts`: pauta
  // charts are filtered by the pauta's own createdAt, and a pauta from this
  // period can belong to a contact created before it.
  const openPautaDrill = useCallback((title: string, pautaItems: Pauta[]) => {
    if (pautaUniqueLeads) {
      // Unique-leads mode: the chart counts each contact's first-ever pauta (rank 0),
      // so keep only those and resolve to their contacts — one row per lead, matching
      // the bar. A contact's later (reingreso) pautas are excluded here.
      const leads = pautaItems.filter((p) => p.contactId && isUniqueLead(p))
      const contactIds = new Set(leads.map(p => p.contactId).filter((id): id is string => Boolean(id)))
      const contactItems = lookupContacts.filter(c => contactIds.has(c.id))
      setDrill({ open: true, title, opportunities: [], contactItems })
    } else {
      // Records mode: the chart counts pauta records, so show one row per pauta
      // (contacts may repeat, and contact-less pautas — the "Otro" bucket — still
      // appear) so the drawer count matches the chart exactly.
      const items = pautaItems.map(p => ({
        pauta: p,
        contact: p.contactId ? contactById.get(p.contactId) : undefined,
      }))
      setDrill({ open: true, title, opportunities: [], pautaItems: items })
    }
  }, [lookupContacts, contactById, pautaUniqueLeads, isUniqueLead])

  // Always a records-mode drill, mirroring openSinContactoDrill. openPautaDrill
  // can't be reused here: it branches on pautaUniqueLeads — the toggle belonging
  // to the channel chart — and would resolve to contacts, so the drawer count
  // would stop matching this chart's bars depending on an unrelated control.
  const openPautaRecordsDrill = useCallback(
    (title: string, pautaItems: Pauta[]) => {
      setDrill({
        open: true,
        title,
        opportunities: [],
        pautaItems: pautaItems.map((p) => ({
          pauta: p,
          contact: p.contactId ? contactById.get(p.contactId) : undefined,
        })),
      })
    },
    [contactById],
  )

  // Pautas por canal (tipo) apiladas por plataforma de origen del contacto.
  // pautaUniqueLeads === true counts distinct contacts per tipo×platform (so the
  // tooltip matches the drill drawer exactly); otherwise it counts pauta records.
  const { pautasByTipoRows, pautasByTipoPlatforms, pautasByTipoTotal } = useMemo(() => {
    const byTipo = new Map<string, Map<string, number>>()
    const platformTotals = new Map<string, number>()

    // Records mode counts every pauta. Unique-leads mode counts only each contact's
    // FIRST-ever pauta (rank 0) — later pautas are reingresos, not new leads — so the
    // total matches the "Leads únicos" KPI (pautas − reingresos). Both bucket by
    // tipo × the contact's origin platform.
    for (const p of pautas) {
      if (pautaUniqueLeads) {
        if (!p.contactId) continue
        if (!isUniqueLead(p)) continue
      }
      const platform = platformFromContact(p.contactId ? contactById.get(p.contactId) : undefined)
      if (!byTipo.has(p.tipo)) byTipo.set(p.tipo, new Map())
      const m = byTipo.get(p.tipo)!
      m.set(platform, (m.get(platform) ?? 0) + 1)
      platformTotals.set(platform, (platformTotals.get(platform) ?? 0) + 1)
    }

    // Standardized "Origen de lead" legend: always present the full canonical
    // platform order, including zero-count platforms, so the legend is identical
    // across charts regardless of which platforms appear in the data.
    const platforms = [...PLATFORM_ORDER]
    const sumRow = (r: Record<string, string | number>) => platforms.reduce((s, k) => s + (r[k] as number), 0)
    const rows = Array.from(byTipo.entries())
      .map(([tipo, m]) => {
        const row: Record<string, string | number> = { tipo }
        for (const k of platforms) row[k] = m.get(k) ?? 0
        return row
      })
      .sort((a, b) => sumRow(b) - sumRow(a))
    const pautasByTipoTotal = rows.reduce((s, r) => s + sumRow(r), 0)
    return { pautasByTipoRows: rows, pautasByTipoPlatforms: platforms, pautasByTipoTotal }
  }, [pautas, contactById, pautaUniqueLeads, isUniqueLead])

  // Attribution (URL or Ad ID) × Etapa del Pipeline (stacked bar: X = stage, Y = opp count, color = attribution key).
  const { pautaByStageRows, pautaByStageKeys, pautaByStageKeyCount } = useMemo(() => {
    const totals = new Map<string, number>()
    const perStage = new Map<string, Map<string, number>>()
    for (const stage of stageOrder) perStage.set(stage, new Map())

    for (const opp of opportunities) {
      if (!isDePauta(opp)) continue
      if (!stageIncludeLost && opp.status === "lost") continue
      const rawKey = paidGroupByKey(opp, stageGroupBy, pautaNameByContact)
      if (!rawKey) continue
      const stageMap = perStage.get(opp.stage)
      if (!stageMap) continue
      stageMap.set(rawKey, (stageMap.get(rawKey) ?? 0) + 1)
      totals.set(rawKey, (totals.get(rawKey) ?? 0) + 1)
    }

    const allKeys = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
    const pautaByStageKeyCount = allKeys.length
    const keys = stageTopN >= pautaByStageKeyCount ? allKeys : allKeys.slice(0, Math.round(stageTopN))

    const rows = stageOrder
      .map((stage) => {
        const row: Record<string, string | number> = { stage }
        const stageMap = perStage.get(stage)!
        for (const k of keys) row[k] = stageMap.get(k) ?? 0
        return row
      })
      .filter((row) => keys.some((k) => (row[k] as number) > 0))

    return { pautaByStageRows: rows, pautaByStageKeys: keys, pautaByStageKeyCount }
  }, [opportunities, stageOrder, stageGroupBy, stageTopN, stageIncludeLost, isDePauta, pautaNameByContact])

  const stageCampaignCut = campaignPrefixCut(pautaByStageKeys, stageGroupBy)
  const pautaByStageConfig = Object.fromEntries(
    pautaByStageKeys.map((k, i) => [
      k,
      { label: paidGroupByLabel(k, stageGroupBy, stageCampaignCut), color: stageGroupBy === "platform" ? (PLATFORM_COLORS[k] ?? CHART_PALETTE[i % CHART_PALETTE.length]) : CHART_PALETTE[i % CHART_PALETTE.length] },
    ])
  )

  const pautaByStageTotal = pautaByStageRows.reduce(
    (s, r) => s + pautaByStageKeys.reduce((a, k) => a + ((r[k] as number) || 0), 0),
    0
  )

  // Lost pauta opportunities: one bar per recorded lost reason (Y axis), each bar
  // stacked by the active dimension (campaign or origin, per the lostGroupBy
  // toggle). Reasons stay sorted heaviest-first; segment keys are ranked by total
  // volume so colors are stable and the legend reads top-down. `total` on each row
  // preserves the per-reason count for the PDF report (which has no toggle).
  const { lostByReasonRows, lostByReasonKeys, lostByReasonKeyCount } = useMemo(() => {
    const reasonTotals = new Map<string, number>()
    const perReason = new Map<string, Map<string, number>>()
    const segTotals = new Map<string, number>()

    for (const opp of opportunities) {
      if (opp.status !== "lost") continue
      if (!isDePauta(opp)) continue
      const reason = opp.lostReason || "Sin razón"
      const segKey = paidGroupByKey(opp, lostGroupBy, pautaNameByContact)
      if (!segKey) continue
      reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + 1)
      if (!perReason.has(reason)) perReason.set(reason, new Map())
      const segMap = perReason.get(reason)!
      segMap.set(segKey, (segMap.get(segKey) ?? 0) + 1)
      segTotals.set(segKey, (segTotals.get(segKey) ?? 0) + 1)
    }

    const allKeys = Array.from(segTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
    const keyCount = allKeys.length
    const keys = lostTopN >= keyCount ? allKeys : allKeys.slice(0, Math.round(lostTopN))

    const rows = Array.from(reasonTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, total]) => {
        const segMap = perReason.get(reason)!
        const row: Record<string, string | number> = { reason, total }
        for (const k of keys) row[k] = segMap.get(k) ?? 0
        return row
      })
      // Drop reasons whose entire volume fell outside the shown segment keys.
      .filter((row) => keys.some((k) => (row[k] as number) > 0))

    return { lostByReasonRows: rows, lostByReasonKeys: keys, lostByReasonKeyCount: keyCount }
  }, [opportunities, isDePauta, lostGroupBy, lostTopN, pautaNameByContact])

  const lostCampaignCut = campaignPrefixCut(lostByReasonKeys, lostGroupBy)
  const lostByReasonConfig = Object.fromEntries(
    lostByReasonKeys.map((k, i) => [
      k,
      { label: paidGroupByLabel(k, lostGroupBy, lostCampaignCut), color: lostGroupBy === "platform" ? (PLATFORM_COLORS[k] ?? CHART_PALETTE[i % CHART_PALETTE.length]) : CHART_PALETTE[i % CHART_PALETTE.length] },
    ])
  )

  const lostByReasonTotal = lostByReasonRows.reduce((s, r) => s + (r.total as number), 0)

  // Count only pautas in the active date window whose full-history rank is 2nd+.
  const reingresoCount = useMemo(
    () => pautas.filter((p) => (pautaReingresoMap.get(p.id) ?? "Primer ingreso") !== "Primer ingreso").length,
    [pautas, pautaReingresoMap]
  )

  // Pautas grouped by calendar month (YYYY-MM), stacked by reingreso number.
  const { pautasByMonthRows, pautasByMonthKeys } = useMemo(() => {
    if (pautas.length === 0) return { pautasByMonthRows: [], pautasByMonthKeys: [] }

    const byMonth = new Map<string, Map<string, number>>()
    const reingresoTotals = new Map<string, number>()

    for (const p of pautas) {
      if (!p.contactId) continue
      const dateStr = toUTCDateStr(p.createdAt)
      if (!dateStr) continue
      const monthKey = dateStr.slice(0, 7)
      const reingreso = pautaReingresoMap.get(p.id) ?? "Primer ingreso"

      if (!byMonth.has(monthKey)) byMonth.set(monthKey, new Map())
      const m = byMonth.get(monthKey)!
      m.set(reingreso, (m.get(reingreso) ?? 0) + 1)
      reingresoTotals.set(reingreso, (reingresoTotals.get(reingreso) ?? 0) + 1)
    }

    // Keep keys in canonical REINGRESO_LABELS order (only those with data)
    const keys = REINGRESO_LABELS.filter((k) => reingresoTotals.has(k))

    const sortedMonths = Array.from(byMonth.keys()).sort()

    const rows = sortedMonths.map((monthKey) => {
      const label = new Date(monthKey + "-15T12:00:00Z")
        .toLocaleDateString("es-MX", { month: "short", year: "2-digit" })
      const row: Record<string, string | number> = { monthKey, monthLabel: label }
      const m = byMonth.get(monthKey)!
      for (const k of keys) row[k] = m.get(k) ?? 0
      return row
    })

    return { pautasByMonthRows: rows, pautasByMonthKeys: keys }
  }, [pautas, pautaReingresoMap])

  const pautaOpps = useMemo(
    () => opportunities.filter((o) => isDePauta(o)),
    [opportunities, isDePauta],
  )
  const pautaOppCount = pautaOpps.length

  // Pautas with no resolvable lead: either the record carries no contactId at all,
  // or it points at a contact that no longer exists. They inflate the pauta count
  // without ever producing a lead, so surface them for cleanup in GHL. Same test
  // the drill drawer uses to render its "Pauta sin contacto vinculado" rows.
  const pautasSinContacto = useMemo(
    () => pautas.filter((p) => !p.contactId || !contactById.has(p.contactId)),
    [pautas, contactById],
  )

  // Always a records-mode drill: in unique-leads mode openPautaDrill resolves to
  // contacts, and these pautas have none — the drawer would come back empty.
  const openSinContactoDrill = useCallback(() => {
    setDrill({
      open: true,
      title: "Pautas sin contacto vinculado",
      opportunities: [],
      pautaItems: pautasSinContacto.map((p) => ({ pauta: p, contact: undefined })),
    })
  }, [pautasSinContacto])

  // Summary-strip drills. Each one shows exactly the rows behind its own number,
  // so the drawer count always matches the tile.
  const openAllOpportunitiesDrill = useCallback(
    () => openDrill("Oportunidades", opportunities),
    [openDrill, opportunities],
  )
  const openPautaOppsDrill = useCallback(
    () => openDrill("Oportunidades por pauta", pautaOpps),
    [openDrill, pautaOpps],
  )
  // Records mode, not openPautaDrill: the tile counts pauta records (including the
  // contact-less ones), and openPautaDrill would collapse them to unique leads
  // whenever the channel chart's toggle happens to be on.
  const openAllPautasDrill = useCallback(
    () => openPautaRecordsDrill("Pautas", pautas),
    [openPautaRecordsDrill, pautas],
  )

  // Table 1: group all opportunities by their GHL source field (normalized)
  // source is the manually-set field in GHL — "tiktok", "Sitio Web", "Referido", numeric FB IDs, etc.
  // Single "Rendimiento por origen" table: group opportunities by platform,
  // Ad ID, or attribution URL (3-way toggle). In id/url modes opps without a
  // pauta are excluded; platform mode keeps everything (falls back to "Otro").
  const originRows = useMemo(() => {
    const map = new Map<string, Opportunity[]>()
    for (const o of opportunities) {
      let key: string | null
      if (originGroupBy === "platform") key = platformLabel(o)
      else if (originGroupBy === "id") key = o.adId || null
      else key = o.attributionUrl || null
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(o)
    }
    return Array.from(map.entries())
      .map(([key, opps]) => {
        const wonOpps = opps.filter(isWonOpp)
        const wonValue = wonOpps.reduce((s, o) => s + o.value, 0)
        return {
          key,
          label: originGroupBy === "url" ? paidTrafficUrlLabel(key) : key,
          total: opps.length,
          wonCount: wonOpps.length,
          wonValue,
          closeRate: opps.length > 0 ? (wonOpps.length / opps.length) * 100 : 0,
          avgTicket: wonOpps.length > 0 ? wonValue / wonOpps.length : 0,
          opps,
        }
      })
      .sort((a, b) => b.wonCount - a.wonCount || b.total - a.total)
  }, [opportunities, originGroupBy])

  // Panel 2 — Opportunities by Ad ID (table)
  const leadsByAdId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of opportunities) {
      if (!o.adId) continue
      counts.set(o.adId, (counts.get(o.adId) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([adId, count]) => ({ adId, count }))
  }, [opportunities])

  // Panel 3 — Landing URLs split by platform (Facebook vs Instagram)
  const leadsByPlatformUrl = useMemo(() => {
    const fb = new Map<string, number>()
    const ig = new Map<string, number>()
    for (const o of opportunities) {
      const url = o.attributionUrl
      if (!url) continue
      const platform = urlPlatform(url)
      if (platform === "facebook") fb.set(url, (fb.get(url) ?? 0) + 1)
      else if (platform === "instagram") ig.set(url, (ig.get(url) ?? 0) + 1)
    }
    const toRows = (m: Map<string, number>) =>
      Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([url, count]) => ({ url, count }))
    return { fb: toRows(fb), ig: toRows(ig) }
  }, [opportunities])

  const apptStatuses = useMemo(() => {
    const s = new Set(appointments.map((a) => a.status).filter(Boolean))
    return Array.from(s).sort()
  }, [appointments])

  // Panel 4a — Paid traffic leads with at least one appointment
  // Leads with an appointment, counted per attribution key. The pipeline stage is a
  // separate story (its own "por Etapa del Pipeline" chart), so it stays out of this
  // bar and lives in the drill-down. One solid bar per key, sorted heaviest-first.
  const { paidTrafficWithAppt, apptKeyCount } = useMemo(() => {
    const filteredAppts = apptStatusFilter === "all"
      ? appointments
      : appointments.filter((a) => a.status === apptStatusFilter)
    const apptContactIds = new Set(filteredAppts.map((a) => a.contactId))
    const counts = new Map<string, number>()
    for (const o of opportunities) {
      if (!isDePauta(o)) continue
      if (!apptContactIds.has(o.contactId)) continue
      const rawKey = paidGroupByKey(o, apptGroupBy, pautaNameByContact)
      if (!rawKey) continue
      counts.set(rawKey, (counts.get(rawKey) ?? 0) + 1)
    }
    const allEntries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
    const apptKeyCount = allEntries.length
    const prefixCut = campaignPrefixCut(allEntries.map(([k]) => k), apptGroupBy)
    const sliced = apptTopN >= apptKeyCount ? allEntries : allEntries.slice(0, Math.round(apptTopN))
    return {
      paidTrafficWithAppt: sliced.map(([rawKey, count]) => ({
        rawKey,
        label: paidGroupByLabel(rawKey, apptGroupBy, prefixCut),
        count,
      })),
      apptKeyCount,
    }
  }, [opportunities, appointments, apptGroupBy, apptTopN, apptStatusFilter, isDePauta, pautaNameByContact])

  const apptChartConfig = { count: { label: "Leads con cita", color: BRAND_AMBER } }

  // Panel 4b — Won deals from paid traffic, grouped by URL or Ad ID
  const { wonPaidTraffic, wonKeyCount } = useMemo(() => {
    const counts = new Map<string, { count: number; value: number }>()
    for (const o of opportunities) {
      if (!isDePauta(o) || !isWonOpp(o)) continue
      const rawKey = paidGroupByKey(o, wonGroupBy, pautaNameByContact)
      if (!rawKey) continue
      const prev = counts.get(rawKey) ?? { count: 0, value: 0 }
      counts.set(rawKey, { count: prev.count + 1, value: prev.value + o.value })
    }
    const allEntries = Array.from(counts.entries()).sort((a, b) => b[1].count - a[1].count)
    const wonKeyCount = allEntries.length
    const prefixCut = campaignPrefixCut(allEntries.map(([k]) => k), wonGroupBy)
    const sliced = wonTopN >= wonKeyCount ? allEntries : allEntries.slice(0, Math.round(wonTopN))
    return {
      wonPaidTraffic: sliced.map(([rawKey, { count, value }]) => ({
        rawKey,
        label: paidGroupByLabel(rawKey, wonGroupBy, prefixCut),
        count,
        value,
      })),
      wonKeyCount,
    }
  }, [opportunities, wonGroupBy, wonTopN, isDePauta, pautaNameByContact])

  // Won opportunities: bars by the standardized "Origen de lead" platform
  // (full PLATFORM_ORDER on the x-axis), stacked by Fuente de creación segments
  // (SOURCE_CATEGORY_ORDER) — same two dimensions as "Oportunidades por fuente".
  const wonBySource = useMemo(() => {
    const byPlatform = new Map<string, Map<string, number>>()
    for (const o of opportunities) {
      if (!isWonOpp(o)) continue
      const platform = platformLabel(o)
      const cat = sourceCategory(o)
      if (!byPlatform.has(platform)) byPlatform.set(platform, new Map())
      const m = byPlatform.get(platform)!
      m.set(cat, (m.get(cat) ?? 0) + 1)
    }
    return PLATFORM_ORDER.map((platform) => {
      const m = byPlatform.get(platform) ?? new Map<string, number>()
      const row: Record<string, string | number> = { platform }
      for (const cat of SOURCE_CATEGORY_ORDER) row[cat] = m.get(cat) ?? 0
      return row
    })
  }, [opportunities])

  const wonTotal = useMemo(
    () => opportunities.reduce((s, o) => (isWonOpp(o) ? s + 1 : s), 0),
    [opportunities],
  )

  // PDF report spec from the same memos the charts render. Computed on click
  // so it always reflects the current toggles (groupBy, topN, etc.).
  const buildReport = useCallback((): ReportInput => {
    const mxn = (v: number) =>
      v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
    const sections: ReportSection[] = []

    if (leadsByCategory.length > 0) {
      const cats = SOURCE_CATEGORY_ORDER.filter((cat) =>
        leadsByCategory.some((r) => r.breakdown.some((b) => b.category === cat))
      )
      sections.push({
        id: "fuentes",
        title: "Oportunidades por fuente",
        explanation:
          "Muestra de qué plataforma proviene cada oportunidad (Facebook, Instagram, TikTok, etc.), desglosada por la fuente de creación del registro en el CRM. Sirve para ver qué canales generan más leads.",
        blocks: [{
          t: "chart", type: "bar", stacked: true, valueLabel: "Oportunidades",
          title: `Oportunidades por plataforma de origen (total: ${opportunities.length})`,
          categories: leadsByCategory.map((r) => r.platform),
          series: cats.map((cat) => ({
            name: cat,
            values: leadsByCategory.map((r) => r.breakdown.find((b) => b.category === cat)?.count ?? 0),
          })),
        }],
      })
    }

    if (pautasByTipoRows.length > 0) {
      const plats = pautasByTipoPlatforms.filter((p) =>
        pautasByTipoRows.some((r) => (r[p] as number) > 0)
      )
      sections.push({
        id: "pautas-canal",
        title: "Pautas por canal de contacto",
        explanation:
          "Cuántos registros de pauta entraron por cada canal (tipo de pauta), apilados por la plataforma de origen del contacto. Indica por dónde están llegando los leads de campañas.",
        blocks: [{
          t: "chart", type: "bar", stacked: true, valueLabel: "Pautas",
          title: `Pautas por canal (total: ${pautasByTipoTotal})`,
          categories: pautasByTipoRows.map((r) => String(r.tipo)),
          series: plats.map((p) => ({
            name: p,
            values: pautasByTipoRows.map((r) => (r[p] as number) ?? 0),
          })),
        }],
      })
    }

    if (pautasByMonthRows.length > 0) {
      sections.push({
        id: "pautas-mes",
        title: "Pautas creadas por mes y reingresos",
        explanation:
          "Evolución mensual de las pautas creadas, separando el primer ingreso de cada contacto de sus reingresos posteriores. Permite ver la tendencia de volumen y cuánto del tráfico es recurrente.",
        blocks: [{
          t: "chart", type: "bar", stacked: true, valueLabel: "Pautas",
          title: `Pautas por mes (reingresos: ${reingresoCount})`,
          categories: pautasByMonthRows.map((r) => String(r.monthLabel)),
          series: pautasByMonthKeys.map((k) => ({
            name: k,
            values: pautasByMonthRows.map((r) => (r[k] as number) ?? 0),
          })),
        }],
      })
    }

    if (pautaByStageRows.length > 0) {
      sections.push({
        id: "pauta-etapa",
        title: "Oportunidades de pauta por etapa del pipeline",
        explanation:
          `Dónde están hoy las oportunidades que vienen de pauta dentro del pipeline de ventas${stageIncludeLost ? "" : " (sin contar las perdidas)"}, con cada barra dividida por ${paidGroupByNoun(stageGroupBy)}. Muestra qué tan profundo avanza el tráfico pagado en el embudo y qué campañas sostienen cada etapa.`,
        blocks: [{
          t: "chart", type: "bar", stacked: true, valueLabel: "Oportunidades",
          title: `Oportunidades de pauta por etapa${stageIncludeLost ? "" : " (sin perdidas)"} (total: ${pautaByStageTotal})`,
          categories: pautaByStageRows.map((r) => String(r.stage)),
          series: pautaByStageKeys.map((k) => ({
            name: pautaByStageConfig[k]?.label ?? k,
            values: pautaByStageRows.map((r) => (r[k] as number) ?? 0),
          })),
        }],
      })
    }

    if (lostByReasonRows.length > 0) {
      sections.push({
        id: "perdidas",
        title: "Oportunidades perdidas por razón de pérdida",
        explanation:
          "Las razones registradas al marcar como perdida una oportunidad de pauta, ordenadas de mayor a menor. Identifica los motivos principales por los que se cae el tráfico pagado.",
        blocks: [{
          t: "chart", type: "bar", orientation: "h", valueLabel: "Oportunidades",
          title: `Perdidas por razón (total: ${lostByReasonTotal})`,
          // Rows already sorted heaviest-first — the PDF has no hover, so ordering carries the ranking.
          categories: lostByReasonRows.map((r) => r.reason as string),
          series: [{
            name: "Oportunidades",
            values: lostByReasonRows.map((r) => r.total as number),
          }],
        }],
      })
    }

    if (leadsByAdId.length > 0) {
      sections.push({
        id: "anuncios",
        title: "Oportunidades por ID de anuncio",
        explanation:
          "Los anuncios específicos (por su ID) que más oportunidades generaron. Útil para identificar los creativos ganadores de las campañas.",
        blocks: [{
          t: "table",
          headers: ["ID de anuncio", "Oportunidades"],
          rows: leadsByAdId.slice(0, 10).map((r) => [r.adId, String(r.count)]),
        }],
      })
    }

    if (leadsByPlatformUrl.fb.length > 0 || leadsByPlatformUrl.ig.length > 0) {
      sections.push({
        id: "urls",
        title: "Oportunidades por URL (Facebook / Instagram)",
        explanation:
          "Las URLs de atribución de Facebook e Instagram que más oportunidades trajeron — cada URL corresponde a una publicación o anuncio concreto.",
        blocks: [{
          t: "table",
          headers: ["Plataforma", "URL", "Oportunidades"],
          rows: [
            ...leadsByPlatformUrl.fb.slice(0, 8).map((r) => ["Facebook", paidTrafficUrlLabel(r.url), String(r.count)]),
            ...leadsByPlatformUrl.ig.slice(0, 8).map((r) => ["Instagram", paidTrafficUrlLabel(r.url), String(r.count)]),
          ],
        }],
      })
    }

    if (paidTrafficWithAppt.length > 0) {
      sections.push({
        id: "citas-pauta",
        title: "Citas por pauta",
        explanation:
          `Leads de tráfico pagado que llegaron a agendar al menos una cita, agrupados por ${paidGroupByNoun(apptGroupBy)} y ordenados de mayor a menor${apptStatusFilter === "all" ? "" : ` (citas con estatus "${apptStatusFilter}")`}. Mide qué campañas generan leads que avanzan a una reunión real.`,
        blocks: [{
          t: "chart", type: "bar", orientation: "h", valueLabel: "Leads con cita",
          title: `Citas por pauta (top ${Math.min(12, paidTrafficWithAppt.length)} de ${apptKeyCount})`,
          categories: paidTrafficWithAppt.slice(0, 12).map((r) => String(r.label)),
          series: [{
            name: "Leads con cita",
            values: paidTrafficWithAppt.slice(0, 12).map((r) => r.count),
          }],
        }],
      })
    }

    if (wonPaidTraffic.length > 0) {
      sections.push({
        id: "ganadas-pauta",
        title: "Oportunidades ganadas por pauta",
        explanation:
          `Ventas cerradas que se originaron en tráfico pagado, agrupadas por ${paidGroupByNoun(wonGroupBy)}. Es el cierre del ciclo: qué campañas terminan en ingresos. La tabla añade el valor monetario de cada grupo.`,
        blocks: [
          {
            t: "chart", type: "bar", valueLabel: "Ganadas",
            title: `Ganadas de tráfico pagado (top ${Math.min(12, wonPaidTraffic.length)} de ${wonKeyCount})`,
            series: wonPaidTraffic.slice(0, 12).map((r) => ({ label: r.label, value: r.count })),
          },
          {
            t: "table",
            headers: ["Pauta", "Ganadas", "Valor"],
            rows: wonPaidTraffic.slice(0, 12).map((r) => [r.label, String(r.count), mxn(r.value)]),
          },
        ],
      })
    }

    // Same two dimensions as "Oportunidades por fuente" (plataforma × fuente de
    // creación), so the two charts can be read against each other.
    const wonPlatforms = wonBySource.filter((r) =>
      SOURCE_CATEGORY_ORDER.some((c) => ((r[c] as number) || 0) > 0)
    )
    if (wonPlatforms.length > 0) {
      const wonCats = SOURCE_CATEGORY_ORDER.filter((c) =>
        wonPlatforms.some((r) => ((r[c] as number) || 0) > 0)
      )
      sections.push({
        id: "ganadas-fuente",
        title: "Oportunidades ganadas por fuente",
        explanation:
          "Ventas cerradas según la plataforma de origen del lead, desglosadas por la fuente de creación del registro en el CRM. Comparada contra «Oportunidades por fuente», muestra qué canales no solo traen volumen sino que convierten en clientes.",
        blocks: [{
          t: "chart", type: "bar", stacked: true, valueLabel: "Ganadas",
          title: `Ganadas por plataforma (total: ${wonTotal})`,
          categories: wonPlatforms.map((r) => String(r.platform)),
          series: wonCats.map((c) => ({
            name: c,
            values: wonPlatforms.map((r) => (r[c] as number) ?? 0),
          })),
        }],
      })
    }

    // Last in the panel, last here — it closes the report with the per-channel
    // return on everything the sections above described.
    if (originRows.length > 0) {
      sections.push({
        id: "rendimiento",
        title: "Rendimiento por origen",
        explanation:
          `Tabla comparativa por ${originGroupBy === "platform" ? "origen del lead" : originGroupBy === "id" ? "ID de anuncio" : "URL de atribución"}: cuántos leads generó, cuántos se ganaron, el porcentaje de cierre, el valor ganado y el ticket promedio. Es la vista de retorno por canal: dónde se justifica la inversión.`,
        blocks: [{
          t: "table",
          headers: ["Origen", "Leads", "Ganados", "% Cierre", "Valor ganado", "Ticket prom."],
          rows: originRows.slice(0, 12).map((r) => [
            r.label,
            String(r.total),
            String(r.wonCount),
            `${r.closeRate.toFixed(1)}%`,
            r.wonValue > 0 ? mxn(r.wonValue) : "—",
            r.avgTicket > 0 ? mxn(r.avgTicket) : "—",
          ]),
        }],
      })
    }

    return {
      reportType: "marketing",
      title: "Reporte de Marketing",
      locationName,
      periodLabel,
      filtersLabel,
      kpis: [
        { label: "Oportunidades", value: String(opportunities.length) },
        { label: "Oportunidades por pauta", value: String(pautaOppCount) },
        { label: "Pautas", value: String(pautas.length) },
        { label: "Leads únicos", value: String(pautas.length - reingresoCount) },
        { label: "Reingresos", value: String(reingresoCount) },
      ],
      sections,
    }
  }, [
    leadsByCategory, pautasByTipoRows, pautasByTipoPlatforms, pautasByTipoTotal,
    pautasByMonthRows, pautasByMonthKeys, pautaByStageRows, pautaByStageKeys, pautaByStageTotal,
    lostByReasonRows, lostByReasonTotal, originRows, leadsByAdId,
    leadsByPlatformUrl, paidTrafficWithAppt, apptKeyCount,
    wonPaidTraffic, wonKeyCount, wonBySource, wonTotal,
    opportunities.length, pautaOppCount, pautas.length, reingresoCount, periodLabel, filtersLabel,
    locationName, originGroupBy, stageIncludeLost, stageGroupBy, pautaByStageConfig,
    apptGroupBy, apptStatusFilter, wonGroupBy,
  ])

  return (
    <DashboardShell>
      <div className="flex justify-end">
        <ExportReportButton getInput={buildReport} />
      </div>

      <MarketingSummaryStrip
        opportunities={opportunities.length}
        pautas={pautas.length}
        uniquePautas={pautas.length - reingresoCount}
        reingresoPautas={reingresoCount}
        pautaOpportunities={pautaOppCount}
        sinContactoPautas={pautasSinContacto.length}
        onSinContactoClick={openSinContactoDrill}
        onOpportunitiesClick={openAllOpportunitiesDrill}
        onPautaOpportunitiesClick={openPautaOppsDrill}
        onPautasClick={openAllPautasDrill}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
     
        <DashboardCard>
          <ChartCardHeader
            title="Oportunidades por fuente"
            total={opportunities.length}
            icon={Tag}
            actions={<OrigenDeLeadInfo />}
          />
          <ChartCardContent>
            {leadsByCategory.length === 0 ? (
              <ChartEmpty message="Sin datos de fuente." height={200} />
            ) : (() => {
              const total = opportunities.length
              const maxVal = Math.max(...leadsByCategory.map((e) => e.total))
              // Donut — one slice per platform
              const donutData = leadsByCategory.map((e) => ({ name: e.platform, value: e.total, color: e.color }))
              return (
                <div className="flex items-center gap-4">
                  {/* Donut */}
                  <div style={{ width: 160, height: 400, flexShrink: 0, position: "relative" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={donutData}
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={72}
                          dataKey="value"
                          nameKey="name"
                          startAngle={90}
                          endAngle={-270}
                          stroke="none"
                          paddingAngle={2}
                          activeIndex={hoveredAdType}
                          activeShape={(props: any) => (
                            <Sector
                              cx={props.cx}
                              cy={props.cy}
                              innerRadius={props.innerRadius}
                              outerRadius={props.outerRadius + 5}
                              startAngle={props.startAngle}
                              endAngle={props.endAngle}
                              fill={props.fill}
                              stroke="none"
                            />
                          )}
                        >
                          {donutData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div
                      style={{
                        position: "absolute",
                        top: "50%",
                        left: "50%",
                        transform: "translate(-50%, -50%)",
                        textAlign: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ color: "hsl(var(--foreground))", fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{total}</div>
                      <div style={{ color: "hsl(var(--muted-foreground))", fontSize: 9, marginTop: 2 }}>LEADS</div>
                    </div>
                  </div>

                  {/* Stacked bar list — one row per platform, segments = source category */}
                  <div className="flex flex-1 flex-col gap-y-3">
                    {leadsByCategory.map((entry, i) => {
                      const pct = total > 0 ? Math.round((entry.total / total) * 100) : 0
                      const barWidth = maxVal > 0 ? (entry.total / maxVal) * 100 : 0
                      return (
                        <div
                          key={entry.platform}
                          className="cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-accent/20 transition-colors"
                          onClick={() =>
                            openDrill(
                              `Plataforma: ${entry.platform}`,
                              opportunities.filter((o) => platformLabel(o) === entry.platform)
                            )
                          }
                          onMouseEnter={() => setHoveredAdType(i)}
                          onMouseLeave={() => setHoveredAdType(undefined)}
                        >
                          <div className="flex items-baseline justify-between mb-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <PlatformIcon platform={entry.platform} className="h-3.5 w-3.5 shrink-0" />
                              <span className="text-xs text-foreground truncate">{entry.platform}</span>
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums ml-2 shrink-0">
                              {entry.total} · {pct}%
                            </span>
                          </div>
                          {/* Stacked bar — segments per source category, each individually clickable */}
                          <div className="h-2 rounded bg-muted overflow-hidden flex" style={{ width: `${barWidth}%` }}>
                            {entry.breakdown.map((seg) => (
                              <div
                                key={seg.category}
                                title={`${catLabel(seg.category)}: ${seg.count}`}
                                className="cursor-pointer hover:brightness-125 transition-[filter]"
                                style={{
                                  width: `${entry.total > 0 ? (seg.count / entry.total) * 100 : 0}%`,
                                  backgroundColor: seg.color,
                                  minWidth: seg.count > 0 ? 2 : 0,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openDrill(
                                    `${entry.platform} · ${seg.category}`,
                                    opportunities.filter(
                                      (o) => platformLabel(o) === entry.platform && sourceCategory(o) === seg.category
                                    )
                                  )
                                }}
                              />
                            ))}
                          </div>
                          {/* Category legend — shown whenever there is at least one category so single-type platforms still show their name; pills are clickable */}
                          {entry.breakdown.length >= 1 && (
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
                              {entry.breakdown.map((seg) => (
                                <button
                                  key={seg.category}
                                  type="button"
                                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-accent/30 px-0.5"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openDrill(
                                      `${entry.platform} · ${catLabel(seg.category)}`,
                                      opportunities.filter(
                                        (o) => platformLabel(o) === entry.platform && sourceCategory(o) === seg.category
                                      )
                                    )
                                  }}
                                >
                                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: seg.color }} />
                                  {catLabel(seg.category)} {seg.count}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
            <ChartHint>Haz clic en una fila para ver los leads</ChartHint>
          </ChartCardContent>
        </DashboardCard>

        <DashboardCard>
          <ChartCardHeader
            title="Pautas por canal de contacto"
            total={pautasByTipoTotal}
            icon={FileText}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <OrigenDeLeadInfo />
                <button
                  onClick={() => setPautaUniqueLeads((v) => !v)}
                  className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                >
                  Leads únicos
                  <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${pautaUniqueLeads ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
                    <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${pautaUniqueLeads ? "translate-x-2.5" : "translate-x-0.5"}`} />
                  </span>
                </button>
              </div>
            }
          />
          <ChartCardContent>
            {pautasByTipoRows.length === 0 ? (
              <ChartEmpty message="Sin datos de Pautas." height={220} />
            ) : (
              <>
                <ChartContainer
                  config={Object.fromEntries(
                    pautasByTipoPlatforms.map((k) => [k, { label: k, color: PLATFORM_COLORS[k] ?? BRAND_AMBER }])
                  )}
                  className="aspect-auto"
                  style={{ height: 400 }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pautasByTipoRows} margin={{ top: 5, right: 8, left: 8, bottom: 16 }} barCategoryGap="20%">
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                      <XAxis dataKey="tipo" tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} interval={0} angle={-40} textAnchor="end" tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 20) + "…" : v} />
                      <YAxis tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip content={<NonZeroTooltipContent labelFormatter={(_, p) => p?.[0]?.payload?.tipo ?? String(_)} />} />
                      <Legend
                        wrapperStyle={{ fontSize: 11, paddingTop: 64}}
                        formatter={(value) => <span style={{ color: "#374151" }}>{value}</span>}
                      />
                      {pautasByTipoPlatforms.map((key, i) => (
                        <Bar
                          key={key}
                          dataKey={key}
                          stackId="a"
                          fill={PLATFORM_COLORS[key] ?? BRAND_AMBER}
                          radius={i === pautasByTipoPlatforms.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                          maxBarSize={48}
                          cursor="pointer"
                          onClick={(data: any) => {
                            const count = data[key] as number
                            if (!count) return
                            openPautaDrill(
                              `${data.tipo} · ${key}`,
                              pautas.filter(
                                (p) =>
                                  p.tipo === data.tipo &&
                                  platformFromContact(p.contactId ? contactById.get(p.contactId) : undefined) === key
                              )
                            )
                          }}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
                <ChartHint>{`Apilado por plataforma de origen del contacto · ${pautaUniqueLeads ? "leads únicos" : "pautas"} · haz clic en un segmento para ver los contactos`}</ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>
      </div>

      <CampaignActivityChart
        pautas={pautas}
        isUniqueLead={isUniqueLead}
        onDrill={openPautaRecordsDrill}
      />

      <DashboardCard>
        <ChartCardHeader
          title="Pautas creadas por mes y reingresos"
          total={pautas.length}
          icon={Calendar}
          actions={
            <>
              <button
                onClick={() => setOnlyReingresos((v) => !v)}
                className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              >
                Solo reingresos
                <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${onlyReingresos ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
                  <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${onlyReingresos ? "translate-x-2.5" : "translate-x-0.5"}`} />
                </span>
              </button>
              <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium tabular-nums tracking-wide text-muted-foreground">
                Reingresos: {reingresoCount.toLocaleString("es-MX")}
              </span>
            </>
          }
        />
        <ChartCardContent>
          {pautasByMonthKeys.length === 0 ? (
            <ChartEmpty message="Sin datos de Pautas." height={280} />
          ) : (
            <>
              <ChartContainer
                config={Object.fromEntries(
                  pautasByMonthKeys.map((k) => [k, { label: k, color: REINGRESO_COLORS[k] ?? BRAND_AMBER }])
                )}
                className="aspect-auto"
                style={{ height: 280 }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={pautasByMonthRows}
                    margin={{ top: 5, right: 16, left: 8, bottom: 16 }}
                    barCategoryGap="20%"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis
                      dataKey="monthLabel"
                      tick={{ fontSize: 10, fill: CHART_TICK.fill }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                    />
                    <YAxis
                      tick={{ ...CHART_TICK }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<NonZeroTooltipContent />} />
                    <Legend
                      wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                      formatter={(value) => <span style={{ color: "#374151" }}>{value}</span>}
                    />
                    {(() => {
                      const visibleKeys = pautasByMonthKeys.filter((k) => !onlyReingresos || k !== "Primer ingreso")
                      return visibleKeys.map((key, i) => (
                        <Bar
                          key={key}
                          dataKey={key}
                          stackId="a"
                          fill={REINGRESO_COLORS[key] ?? BRAND_AMBER}
                          radius={i === visibleKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                          maxBarSize={40}
                          cursor="pointer"
                          onClick={(data: any) => {
                            const count = data[key] as number
                            if (!count) return
                            const monthKey = data.monthKey as string
                            const monthLabel = data.monthLabel as string
                            const matchedPautas = pautas.filter(
                              (p) =>
                                p.contactId &&
                                toUTCDateStr(p.createdAt).slice(0, 7) === monthKey &&
                                pautaReingresoMap.get(p.id) === key
                            )
                            const contactIds = new Set(matchedPautas.map((p) => p.contactId))
                            const contactItems = lookupContacts.filter((c) => contactIds.has(c.id))
                            setDrill({ open: true, title: `${key} · ${monthLabel}`, opportunities: [], contactItems })
                          }}
                        />
                      ))
                    })()}
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
              <ChartHint>Apilado por número de reingreso del contacto · haz clic en un segmento para ver las pautas</ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      <DashboardCard>
        <ChartCardHeader
          title={`Oportunidades de Pauta por Etapa del Pipeline${stageIncludeLost ? "" : " (Sin oportunidades perdidas)"}`}
          total={pautaByStageTotal}
          icon={Layers}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setStageIncludeLost((v) => !v)}
                className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              >
                Oportunidades perdidas
                <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${stageIncludeLost ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
                  <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${stageIncludeLost ? "translate-x-2.5" : "translate-x-0.5"}`} />
                </span>
              </button>
              <TopNSlider value={stageTopN} max={pautaByStageKeyCount} onChange={setStageTopN} />
              <GroupByToggle value={stageGroupBy} onChange={setStageGroupBy} />
            </div>
          }
        />
        <ChartCardContent>
          {pautaByStageKeys.length === 0 ? (
            <ChartEmpty message="Sin oportunidades con datos de atribución." height={300} />
          ) : (
            <>
              <ChartContainer config={pautaByStageConfig} className="aspect-auto" style={{ height: 480 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pautaByStageRows} margin={{ top: 5, right: 16, left: 8, bottom: 16 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis
                      dataKey="stage"
                      tick={{ fontSize: 10, fill: CHART_TICK.fill }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + "…" : v}
                    />
                    <YAxis tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <ChartTooltip content={<NonZeroTooltipContent />} />
                    <Legend
                      wrapperStyle={{ fontSize: 10, paddingTop: 48, lineHeight: "36px" }}
                      iconSize={8}
                      formatter={(value: string) => (
                        <span
                          style={{ color: "#374151", marginRight: 4 }}
                          title={value}
                        >
                          {paidGroupByLabel(value, stageGroupBy, stageCampaignCut).slice(0, 20)}
                        </span>
                      )}
                    />
                    {pautaByStageKeys.map((key, i) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        stackId="a"
                        fill={stageGroupBy === "platform" ? (PLATFORM_COLORS[key] ?? CHART_PALETTE[i % CHART_PALETTE.length]) : CHART_PALETTE[i % CHART_PALETTE.length]}
                        radius={i === pautaByStageKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                        maxBarSize={56}
                        cursor="pointer"
                        onClick={(data: any) => {
                          const count = data[key] as number
                          if (!count) return
                          const stage = data.stage as string
                          const items = opportunities.filter((o) => {
                            if (!isDePauta(o)) return false
                            if (o.stage !== stage) return false
                            if (!stageIncludeLost && o.status === "lost") return false
                            return paidGroupByKey(o, stageGroupBy, pautaNameByContact) === key
                          })
                          const label = paidGroupByLabel(key, stageGroupBy, stageCampaignCut)
                          openDrill(
                            `${label} · ${stage}`,
                            items,
                            `${items.length} oportunidad${items.length !== 1 ? "es" : ""} en ${stage}`
                          )
                        }}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
              <ChartHint>
                {`Apilado por ${paidGroupByHint(stageGroupBy)} · ${stageTopN >= pautaByStageKeyCount ? "todo" : `top ${stageTopN}`} · haz clic en un segmento para ver las oportunidades`}
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      <DashboardCard tone="lost">
        <ChartCardHeader
          title="Oportunidades Perdidas por Razón de Pérdida"
          total={lostByReasonTotal}
          icon={TrendingDown}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <TopNSlider value={lostTopN} max={lostByReasonKeyCount} onChange={setLostTopN} />
              <GroupByToggle value={lostGroupBy} onChange={setLostGroupBy} options={CAMPAIGN_ORIGIN_OPTIONS} />
            </div>
          }
        />
        <ChartCardContent>
          {lostByReasonRows.length === 0 ? (
            <ChartEmpty message="Sin oportunidades perdidas de pauta en el periodo." height={300} />
          ) : (
            <>
              <ChartContainer
                config={lostByReasonConfig}
                className="aspect-auto"
                style={{ height: Math.min(760, Math.max(260, lostByReasonRows.length * 44 + 96)) }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={lostByReasonRows}
                    margin={{ top: 5, right: 40, left: 8, bottom: 8 }}
                    barCategoryGap="24%"
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={CHART_GRID_STROKE} />
                    <XAxis type="number" tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="reason"
                      width={168}
                      tick={{ fontSize: 11, fill: CHART_TICK.fill }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      tickFormatter={(v: string) => (v.length > 26 ? v.slice(0, 26) + "…" : v)}
                    />
                    <ChartTooltip content={<NonZeroTooltipContent />} />
                    <Legend
                      wrapperStyle={{ fontSize: 10, paddingTop: 12, lineHeight: "20px" }}
                      iconSize={8}
                      formatter={(value: string) => (
                        <span style={{ color: "#374151", marginRight: 4 }} title={value}>
                          {paidGroupByLabel(value, lostGroupBy, lostCampaignCut).slice(0, 24)}
                        </span>
                      )}
                    />
                    {lostByReasonKeys.map((key, i) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        stackId="a"
                        fill={lostGroupBy === "platform" ? (PLATFORM_COLORS[key] ?? CHART_PALETTE[i % CHART_PALETTE.length]) : CHART_PALETTE[i % CHART_PALETTE.length]}
                        radius={i === lostByReasonKeys.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                        maxBarSize={40}
                        cursor="pointer"
                        onClick={(data: any) => {
                          const count = data[key] as number
                          if (!count) return
                          const reason = data.reason as string
                          const items = opportunities.filter(
                            (o) =>
                              o.status === "lost" &&
                              isDePauta(o) &&
                              (o.lostReason || "Sin razón") === reason &&
                              paidGroupByKey(o, lostGroupBy, pautaNameByContact) === key,
                          )
                          const segLabel = paidGroupByLabel(key, lostGroupBy, lostCampaignCut)
                          openDrill(
                            `${reason} · ${segLabel}`,
                            items,
                            `${items.length} oportunidad${items.length !== 1 ? "es" : ""} perdida${items.length !== 1 ? "s" : ""} — ${reason} · ${segLabel}`,
                          )
                        }}
                      >
                        {i === lostByReasonKeys.length - 1 && (
                          <LabelList dataKey="total" position="right" style={{ fontSize: 11, fill: CHART_TICK.fill }} />
                        )}
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
              <ChartHint>
                {`Cada barra es una razón de pérdida, apilada por ${paidGroupByHint(lostGroupBy)} · ${lostTopN >= lostByReasonKeyCount ? "todo" : `top ${lostTopN}`} · haz clic en un segmento para ver las oportunidades`}
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      {/* Panel 2 — Oportunidades por ID de Anuncio / Panel 3 — URLs por plataforma */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashboardCard>
          <ChartCardHeader
            title="Oportunidades por ID de Anuncio"
            total={leadsByAdId.reduce((s, e) => s + e.count, 0)}
            icon={Tag}
            actions={
              <ScopePill
                label="META · Form + WhatsApp"
                tooltip="Solo pautas de META. El ID de anuncio aplica tanto a pautas de formulario como de WhatsApp."
              />
            }
          />
          <ChartCardContent>
            {leadsByAdId.length === 0 ? (
              <ChartEmpty message="Sin datos de ID de anuncio." height={220} />
            ) : (
              <>
                <div className="overflow-auto max-h-[340px] rounded-md border border-border/40">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs">ID</TableHead>
                        <TableHead className="text-xs text-right"># de oportunidades</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leadsByAdId.map((entry) => (
                        <TableRow
                          key={entry.adId}
                          className="cursor-pointer"
                          onClick={() =>
                            openDrill(
                              `Ad ID: ${entry.adId}`,
                              opportunities.filter((o) => o.adId === entry.adId)
                            )
                          }
                        >
                          <TableCell className="font-mono text-xs text-foreground">
                            <span className="inline-flex items-center gap-0">
                              {entry.adId}
                              <CopyButton value={entry.adId} />
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-sm font-semibold tabular-nums text-foreground">
                            {entry.count}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ChartHint>Haz clic en una fila para ver las oportunidades</ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>

        <DashboardCard>
          <ChartCardHeader
            title="Oportunidades por URL (Facebook / Instagram)"
            total={
              leadsByPlatformUrl.fb.reduce((s, e) => s + e.count, 0) +
              leadsByPlatformUrl.ig.reduce((s, e) => s + e.count, 0)
            }
            icon={BarChart3}
            actions={
              <ScopePill
                label="META · Solo WhatsApp"
                tooltip="Solo pautas de META. La URL solo aplica a pautas de WhatsApp, no de formulario."
              />
            }
          />
          <ChartCardContent>
            {leadsByPlatformUrl.fb.length === 0 && leadsByPlatformUrl.ig.length === 0 ? (
              <ChartEmpty message="Sin datos de URL de Facebook o Instagram." height={220} />
            ) : (
              <>
                <div className="overflow-auto max-h-[340px] rounded-md border border-border/40">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <Facebook className="h-3.5 w-3.5 text-[#1877f2]" /> Facebook
                          </span>
                        </TableHead>
                        <TableHead className="text-xs text-right">#</TableHead>
                        <TableHead className="text-xs border-l border-border/40">
                          <span className="inline-flex items-center gap-1.5">
                            <Instagram className="h-3.5 w-3.5 text-[#e1306c]" /> Instagram
                          </span>
                        </TableHead>
                        <TableHead className="text-xs text-right">#</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from({
                        length: Math.max(leadsByPlatformUrl.fb.length, leadsByPlatformUrl.ig.length),
                      }).map((_, i) => {
                        const fb = leadsByPlatformUrl.fb[i]
                        const ig = leadsByPlatformUrl.ig[i]
                        return (
                          <TableRow key={i} className="hover:bg-transparent">
                            {fb ? (
                              <>
                                <TableCell
                                  className="cursor-pointer font-mono text-xs text-foreground hover:text-primary"
                                  title={fb.url}
                                  onClick={() =>
                                    openDrill(
                                      `Facebook: ${fb.url}`,
                                      opportunities.filter((o) => o.attributionUrl === fb.url)
                                    )
                                  }
                                >
                                  <span className="inline-flex items-center gap-0">
                                    {shortUrlLabel(fb.url)}
                                    <LinkButton value={fb.url} />
                                  </span>
                                </TableCell>
                                <TableCell className="text-right text-sm font-semibold tabular-nums text-foreground">
                                  {fb.count}
                                </TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell />
                                <TableCell />
                              </>
                            )}
                            {ig ? (
                              <>
                                <TableCell
                                  className="cursor-pointer border-l border-border/40 font-mono text-xs text-foreground hover:text-primary"
                                  title={ig.url}
                                  onClick={() =>
                                    openDrill(
                                      `Instagram: ${ig.url}`,
                                      opportunities.filter((o) => o.attributionUrl === ig.url)
                                    )
                                  }
                                >
                                  <span className="inline-flex items-center gap-0">
                                    {shortUrlLabel(ig.url)}
                                    <LinkButton value={ig.url} />
                                  </span>
                                </TableCell>
                                <TableCell className="text-right text-sm font-semibold tabular-nums text-foreground">
                                  {ig.count}
                                </TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell className="border-l border-border/40" />
                                <TableCell />
                              </>
                            )}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
                <ChartHint>Haz clic en una URL para ver las oportunidades</ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>
      </div>

      {/* Panel 4a — Tráfico Pagado con Cita / Panel 4b — Deals Ganados de Tráfico Pagado */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-1">
        <DashboardCard>
          <ChartCardHeader
            title="Citas por pauta"
            total={paidTrafficWithAppt.reduce((s, e) => s + (e.count as number), 0)}
            icon={Calendar}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {apptStatuses.length > 0 && (
                  <Select value={apptStatusFilter} onValueChange={setApptStatusFilter}>
                    <SelectTrigger
                      className="h-7 w-[150px] text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SelectValue placeholder="Todos los estatus" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos los estatus</SelectItem>
                      {apptStatuses.map((s) => (
                        <SelectItem key={s} value={s}>{apptStatusLabel(s)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <TopNSlider value={apptTopN} max={apptKeyCount} onChange={setApptTopN} />
                <GroupByToggle value={apptGroupBy} onChange={setApptGroupBy} />
              </div>
            }
          />
          <ChartCardContent>
            {paidTrafficWithAppt.length === 0 ? (
              <ChartEmpty message="Sin leads de tráfico pagado con cita." height={220} />
            ) : (
              <>
                <ChartContainer
                  config={apptChartConfig}
                  className="aspect-auto"
                  style={{ height: Math.min(560, Math.max(220, paidTrafficWithAppt.length * 40 + 48)) }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      layout="vertical"
                      data={paidTrafficWithAppt}
                      margin={{ top: 5, right: 40, left: 8, bottom: 8 }}
                      barCategoryGap="24%"
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={CHART_GRID_STROKE} />
                      <XAxis type="number" tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={260}
                        tick={(props: any) => {
                          const { x, y, payload } = props
                          const full = String(payload?.value ?? "")
                          const display = full.length > 40 ? full.slice(0, 40) + "…" : full
                          return (
                            <text
                              x={x}
                              y={y}
                              dy={4}
                              textAnchor="end"
                              fontSize={11}
                              fill={CHART_TICK.fill}
                            >
                              <title>{full}</title>
                              {display}
                            </text>
                          )
                        }}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                      />
                      <ChartTooltip
                        content={
                          <NonZeroTooltipContent
                            labelFormatter={(_: unknown, p: any) => p?.[0]?.payload?.rawKey ?? String(_)}
                          />
                        }
                      />
                      <Bar
                        dataKey="count"
                        fill={BRAND_AMBER}
                        radius={[0, 4, 4, 0]}
                        maxBarSize={36}
                        cursor="pointer"
                        onClick={(data: any) => {
                          const rawKey = data.rawKey as string
                          // Mirror the active status filter so the drawer matches the bar.
                          const filteredAppts = apptStatusFilter === "all"
                            ? appointments
                            : appointments.filter((a) => a.status === apptStatusFilter)
                          const apptContactIds = new Set(filteredAppts.map((a) => a.contactId))
                          const items = opportunities.filter(
                            (o) => isDePauta(o) && apptContactIds.has(o.contactId) && paidGroupByKey(o, apptGroupBy, pautaNameByContact) === rawKey,
                          )
                          openDrill(
                            data.label,
                            items,
                            `${items.length} oportunidad${items.length !== 1 ? "es" : ""} con cita`,
                          )
                        }}
                      >
                        <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: CHART_TICK.fill }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
                <ChartHint>Leads de publicidad pagada (Meta/TikTok + Google) con cita · ordenado por # de citas · clic en una barra para ver las oportunidades y su etapa</ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>
      </div>



      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <DashboardCard tone="won">
          <ChartCardHeader
            title="Oportunidades ganadas por pauta"
            total={wonPaidTraffic.reduce((s, e) => s + e.count, 0)}
            icon={TrendingUp}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <TopNSlider value={wonTopN} max={wonKeyCount} onChange={setWonTopN} />
                <GroupByToggle value={wonGroupBy} onChange={setWonGroupBy} />
              </div>
            }
          />
          <ChartCardContent>
            {wonPaidTraffic.length === 0 ? (
              <ChartEmpty message="Sin deals ganados de tráfico pagado." height={220} />
            ) : (
              <>
                <ChartContainer
                  config={{ count: { label: "Ganados", color: BRAND_AMBER } }}
                  className="aspect-auto"
                  style={{ height: 300 }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={wonPaidTraffic}
                      margin={{ top: 16, right: 16, left: 8, bottom: 80 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                      <XAxis
                        dataKey="label"
                        tick={{ ...CHART_TICK }}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        angle={-40}
                        textAnchor="end"
                      />
                      <YAxis tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip
                        content={
                          <NonZeroTooltipContent
                            labelFormatter={(_: unknown, p: any) => {
                              const entry = p?.[0]?.payload
                              if (!entry) return String(_)
                              const val = entry.value as number
                              return val > 0
                                ? `${entry.rawKey} · $${val.toLocaleString("es-MX")}`
                                : entry.rawKey
                            }}
                          />
                        }
                      />
                      <Bar
                        dataKey="count"
                        radius={[6, 6, 0, 0]}
                        name="Ganados"
                        maxBarSize={48}
                        cursor="pointer"
                        onClick={(data: any) => {
                          const rawKey = data.rawKey as string
                          openDrill(
                            `Ganados de tráfico pagado: ${data.label}`,
                            opportunities.filter((o) => {
                              if (!isDePauta(o) || !isWonOpp(o)) return false
                              return paidGroupByKey(o, wonGroupBy, pautaNameByContact) === rawKey
                            })
                          )
                        }}
                      >
                        {wonPaidTraffic.map((entry, i) => (
                          <Cell key={entry.rawKey} fill={chartPaletteColor(i)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
                <ChartHint>Oportunidades ganadas (won) de publicidad pagada (Meta/TikTok + Google) · tooltip muestra valor total</ChartHint>
              </>
            )}
          </ChartCardContent>
        </DashboardCard>
      <DashboardCard tone="won">
        <ChartCardHeader
          title="Oportunidades Ganadas por Fuente"
          total={wonTotal}
          icon={TrendingUp}
          actions={<OrigenDeLeadInfo />}
        />
        <ChartCardContent>
          {wonTotal === 0 ? (
            <ChartEmpty message="Sin oportunidades ganadas." height={220} />
          ) : (
            <>
              <ChartContainer
                config={Object.fromEntries(
                  SOURCE_CATEGORY_ORDER.map((k) => [k, { label: catLabel(k), color: SOURCE_CATEGORY_COLORS[k] ?? BRAND_AMBER }])
                )}
                className="aspect-auto"
                style={{ height: 300 }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={wonBySource} margin={{ top: 16, right: 16, left: 8, bottom: 16 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis
                      dataKey="platform"
                      tick={{ ...CHART_TICK }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-40}
                      textAnchor="end"
                      tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 20) + "…" : v}
                    />
                    <YAxis tick={{ ...CHART_TICK }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <ChartTooltip content={<NonZeroTooltipContent labelFormatter={(_: unknown, p: any) => p?.[0]?.payload?.platform ?? String(_)} />} />
                    <Legend
                      wrapperStyle={{ fontSize: 11, paddingTop: 32 }}
                      formatter={(value) => <span style={{ color: "#374151" }}>{catLabel(String(value))}</span>}
                    />
                    {SOURCE_CATEGORY_ORDER.map((key, i) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        stackId="a"
                        fill={SOURCE_CATEGORY_COLORS[key] ?? BRAND_AMBER}
                        radius={i === SOURCE_CATEGORY_ORDER.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                        maxBarSize={48}
                        cursor="pointer"
                        onClick={(data: any) => {
                          const count = data[key] as number
                          if (!count) return
                          openDrill(
                            `Ganadas: ${data.platform} · ${catLabel(key)}`,
                            opportunities.filter((o) => isWonOpp(o) && platformLabel(o) === data.platform && sourceCategory(o) === key)
                          )
                        }}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
              <ChartHint>Oportunidades ganadas · barras por plataforma de origen, apiladas por fuente de creación · haz clic en un segmento para ver los detalles</ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>
          </div>
      {/* Rendimiento por origen — single table, grouped by platform / Ad ID / URL */}
      <DashboardCard>
        <ChartCardHeader
          title="Rendimiento por origen"
          total={originRows.reduce((s, r) => s + r.wonCount, 0)}
          icon={BarChart3}
          actions={<OriginGroupByToggle value={originGroupBy} onChange={setOriginGroupBy} />}
        />
        <ChartCardContent>
          {originRows.length === 0 ? (
            <ChartEmpty message="Sin datos para este criterio." height={220} />
          ) : (
            <>
              <div className="overflow-auto max-h-[440px] rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs">
                        {ORIGIN_GROUP_OPTIONS.find((o) => o.value === originGroupBy)!.column}
                      </TableHead>
                      <TableHead className="text-xs text-right">Leads</TableHead>
                      <TableHead className="text-xs text-right">Ganados</TableHead>
                      <TableHead className="text-xs text-right">% Cierre</TableHead>
                      <TableHead className="text-xs text-right">Valor</TableHead>
                      <TableHead className="text-xs text-right">Ticket prom.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {originRows.map((row) => {
                      const wonOpps = row.opps.filter(isWonOpp)
                      return (
                        <TableRow key={row.key} className="cursor-pointer">
                          <TableCell className="text-xs font-medium text-foreground">
                            <span className="inline-flex items-center gap-1.5 max-w-[280px]">
                              {originGroupBy === "platform" && (
                                <PlatformIcon platform={row.key} className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <span className="truncate">{row.label}</span>
                              {originGroupBy !== "platform" && <CopyButton value={row.key} />}
                              {originGroupBy === "url" && <LinkButton value={row.key} />}
                            </span>
                          </TableCell>
                          <TableCell
                            className="text-right text-sm tabular-nums text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                            onClick={() => openDrill(`Leads · ${row.label}`, row.opps)}
                          >
                            {row.total}
                          </TableCell>
                          <TableCell
                            className="text-right text-sm font-semibold tabular-nums text-foreground hover:bg-muted/40 transition-colors"
                            onClick={() => openDrill(`Ganados · ${row.label}`, wonOpps)}
                          >
                            {row.wonCount}
                          </TableCell>
                          <TableCell
                            className={`text-right text-xs font-semibold tabular-nums hover:bg-muted/40 transition-colors ${
                              row.closeRate >= 20 ? "text-emerald-600" : row.closeRate >= 10 ? "text-amber-600" : "text-muted-foreground"
                            }`}
                            onClick={() => openDrill(`Ganados · ${row.label}`, wonOpps)}
                          >
                            {row.closeRate.toFixed(1)}%
                          </TableCell>
                          <TableCell
                            className="text-right text-xs tabular-nums text-muted-foreground hover:bg-muted/40 transition-colors"
                            onClick={() => openDrill(`Ganados · ${row.label}`, wonOpps)}
                          >
                            {row.wonValue > 0 ? `$${row.wonValue.toLocaleString("es-MX")}` : "—"}
                          </TableCell>
                          <TableCell
                            className="text-right text-xs tabular-nums text-muted-foreground hover:bg-muted/40 transition-colors"
                            onClick={() => openDrill(`Ganados · ${row.label}`, wonOpps)}
                          >
                            {row.avgTicket > 0
                              ? `$${row.avgTicket.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`
                              : "—"}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              <ChartHint>
                {originGroupBy === "platform"
                  ? "Todas las oportunidades clasificadas por plataforma de origen · Leads abre todos los leads · Ganados / % Cierre / Valor abre solo los ganados"
                  : "Solo oportunidades con pauta · Leads abre todos los leads · Ganados / % Cierre / Valor abre solo los ganados"}
              </ChartHint>
            </>
          )}
        </ChartCardContent>
      </DashboardCard>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={lookupContacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={lookupOpportunities}
        allPautas={rankingPautas}
        appointments={lookupAppointments}
        locationId={locationId}
      />
    </DashboardShell>
  )
}
