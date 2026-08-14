// Dashboard → PDF report composition. Reuses the create_pdf spec/renderer
// (lib/pdf/*) so exported reports share the exact branding/format the AI
// assistant produces; only the content source differs (deterministic code
// over the dashboards' already-computed aggregates instead of the model).

import type { PdfBlock, PdfSpec, PdfChartBlock } from "@/lib/pdf/types"

export interface ReportSection {
  id: string
  title: string
  /** Fixed one/two-sentence Spanish description of what the chart shows. */
  explanation: string
  /**
   * Opt OUT of AI analysis. Every section is analyzed by default — the report's
   * promise is "los mismos gráficos del panel, explicados", so a chart without an
   * interpretation is the exception, not the rule.
   */
  ai?: boolean
  /** Data blocks (chart/table/kpis) already in PdfSpec form. */
  blocks: PdfBlock[]
}

export interface ReportInput {
  reportType: "marketing" | "ventas"
  title: string
  /** Sub-account / location name, used in the download filename. */
  locationName?: string
  /** Human label of the active global date filter, e.g. "Últimos 30 días". */
  periodLabel?: string
  /**
   * Resumen de los filtros de atributo activos ("Status: Ganado · Asesor: Ana").
   * Va aparte de `periodLabel` y no en el `accent` de la portada: un reporte
   * recortado a un asesor que no lo declara miente, pero la portada tampoco
   * aguanta una lista que crece con cada casilla marcada.
   */
  filtersLabel?: string
  kpis: { label: string; value: string }[]
  sections: ReportSection[]
}

export interface ReportAiResult {
  summary?: string
  analyses?: Record<string, string>
}

/** Flatten a section's blocks into compact JSON for the AI payload. */
export function compactSectionData(section: ReportSection): unknown[] {
  return section.blocks.map((b) => {
    if (b.t === "chart") {
      const c = b as PdfChartBlock
      return { kind: "chart", type: c.type, title: c.title, categories: c.categories, series: c.series }
    }
    if (b.t === "table") {
      return { kind: "table", headers: b.headers, rows: b.rows.slice(0, 15) }
    }
    if (b.t === "kpis") {
      return { kind: "kpis", items: b.items }
    }
    return null
  }).filter(Boolean) as unknown[]
}

export function buildAnalyzePayload(input: ReportInput) {
  return {
    reportType: input.reportType,
    periodLabel: input.periodLabel,
    filtersLabel: input.filtersLabel,
    kpis: input.kpis,
    sections: input.sections
      .filter((s) => s.ai !== false)
      .map((s) => ({ id: s.id, title: s.title, data: compactSectionData(s) })),
  }
}

const MESES_ABREV = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
]

// "15 de Jun 2:02pm" — readable Spanish stamp for the download filename.
function reportStamp(d = new Date()): string {
  const dia = d.getDate()
  const mes = MESES_ABREV[d.getMonth()]
  const h24 = d.getHours()
  const ampm = h24 < 12 ? "am" : "pm"
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const min = String(d.getMinutes()).padStart(2, "0")
  return `${dia} de ${mes} ${h12}:${min}${ampm}`
}

export function buildReportSpec(input: ReportInput, ai: ReportAiResult | null): PdfSpec {
  const blocks: PdfBlock[] = []

  blocks.push({ t: "heading", text: "Resumen general" })
  if (input.periodLabel) {
    blocks.push({ t: "text", text: `Periodo del reporte: **${input.periodLabel}**.` })
  }
  if (input.filtersLabel) {
    blocks.push({
      t: "text",
      text: `Filtros aplicados: **${input.filtersLabel}**. Todas las cifras de este reporte están recortadas a ese subconjunto.`,
    })
  }
  blocks.push({ t: "kpis", items: input.kpis })

  if (ai?.summary) {
    blocks.push({ t: "heading", text: "Resumen ejecutivo (IA)" })
    blocks.push({ t: "text", text: ai.summary })
  } else {
    blocks.push({
      t: "callout",
      style: "warn",
      text: "El análisis IA no estuvo disponible al generar este reporte; se incluyen los datos y explicaciones de cada gráfico.",
    })
  }

  // Each panel chart becomes: title → what it shows → the chart itself → what it
  // means for this period. The first two are deterministic; the last is the AI's.
  for (const s of input.sections) {
    blocks.push({ t: "heading", text: s.title })
    blocks.push({ t: "text", text: `**Qué muestra:** ${s.explanation}` })
    blocks.push(...s.blocks)
    const analysis = ai?.analyses?.[s.id]
    if (analysis) {
      blocks.push({ t: "callout", style: "info", text: `Lectura del periodo: ${analysis}` })
    }
  }

  // e.g. "Reporte Marketing Lezgo Suite - 15 de Jun 2:02pm"
  const tipoLabel = input.reportType === "marketing" ? "Marketing" : "Ventas"
  const location = input.locationName?.trim() || "Lezgo Suite"
  const filename = `Reporte ${tipoLabel} ${location} - ${reportStamp()}`

  return {
    title: input.title,
    accent: input.periodLabel,
    client: "Lezgo Suite",
    subtitle:
      input.reportType === "marketing"
        ? "Reporte de adquisición: fuentes, pautas, atribución y resultados de campañas."
        : "Reporte comercial: embudo, conversión, citas y análisis de pérdidas.",
    cover: true,
    filename,
    blocks,
  }
}
