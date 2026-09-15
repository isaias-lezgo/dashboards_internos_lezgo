"use client"

import type { ReactNode } from "react"
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { PMI_CONVERSION_TARGETS, semaphore, type PmiConversions, type PmiIndicator, type PmiTone } from "@/lib/pmi"

export const INDICATOR_LABELS: Record<PmiIndicator, string> = {
  leads: "Leads",
  perfilamientos: "Perfilamientos",
  citas: "Citas efectivas",
  apartados: "Apartados",
  cierres: "Cierres",
}

// Los tres tonos del Excel (verde / cian / rojo) traducidos a la paleta del
// panel: el semáforo es información, no decoración, así que nada de ámbar aquí.
export function toneClass(tone: PmiTone): string {
  switch (tone) {
    case "alto":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
    case "medio":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-200"
    case "bajo":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-200"
    default:
      return "text-muted-foreground"
  }
}

export function fmtInt(n: number): string {
  return n.toLocaleString("es-MX", { maximumFractionDigits: 0 })
}

export function fmtMxn(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
}

export function fmtPct(r: number | null, digits = 0): string {
  if (r === null || !Number.isFinite(r)) return "—"
  return `${(r * 100).toLocaleString("es-MX", { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`
}

export function PmiTile({
  label, value, objective, avance, sub, onClick,
}: {
  label: string
  value: string
  objective: string
  /** resultado ÷ objetivo; null sin objetivo */
  avance: number | null
  sub?: string
  onClick?: () => void
}) {
  // Mismas bandas que las celdas: el tile es el total del mes contra su objetivo.
  const tone = avance === null ? null : semaphore(avance, 1)
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5",
        onClick && "cursor-pointer transition-[border-color] hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } } : undefined}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">Objetivo {objective}</span>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-medium tabular-nums", toneClass(tone))}>{fmtPct(avance)}</span>
      </div>
    </div>
  )
}

const CONVERSION_LABELS: { key: keyof PmiConversions; label: string }[] = [
  { key: "leadPerfil", label: "Leads → Perfilamientos" },
  { key: "perfilCita", label: "Perfilamientos → Citas" },
  { key: "citaApartado", label: "Citas → Apartados" },
  { key: "apartadoCierre", label: "Apartados → Cierres" },
]

export function ConversionStrip({ conversions }: { conversions: PmiConversions }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {CONVERSION_LABELS.map(({ key, label }) => {
        const r = conversions[key]
        const target = PMI_CONVERSION_TARGETS[key]
        const tone: PmiTone = r === null ? null : r >= target ? "medio" : r >= target * 0.75 ? "bajo" : null
        return (
          <div key={key} className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className={cn("rounded px-1.5 text-lg font-semibold tabular-nums", toneClass(tone))}>{fmtPct(r)}</span>
              <span className="text-[11px] text-muted-foreground">meta {fmtPct(target)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function EstimatedNote({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>
        {count} {count === 1 ? "hito tiene" : "hitos tienen"} fecha estimada: son anteriores al arranque de la
        bitácora y llevan la fecha de su última edición en el CRM.
      </span>
    </p>
  )
}

export function PmiSection({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint}
      </div>
      {children}
    </section>
  )
}
