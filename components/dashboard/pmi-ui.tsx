"use client"

import { createContext, useContext, type ReactNode } from "react"
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { PMI_CONVERSION_TARGETS, type PmiConversions, type PmiIndicator, type PmiTone } from "@/lib/pmi"

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

// El mismo semáforo para las barras de Recharts, que no leen clases de Tailwind.
// Tonos medios que aguantan los dos temas; el nulo es el gris de la interfaz.
export function toneFill(tone: PmiTone): string {
  switch (tone) {
    case "alto": return "#10b981"
    case "medio": return "#0ea5e9"
    case "bajo": return "#f43f5e"
    default: return "hsl(var(--muted-foreground) / 0.35)"
  }
}

// Una conversión se colorea contra su meta (≥ meta, ≥ 75 % de la meta, debajo),
// no contra las bandas del semáforo de resultados.
export function conversionTone(r: number | null, target: number): PmiTone {
  if (r === null) return null
  return r >= target ? "medio" : r >= target * 0.75 ? "bajo" : null
}

// ── Avatar por iniciales ────────────────────────────────────────────────────
// No hay fotos: el asesor se reconoce por sus iniciales sobre un color que le
// pertenece. Son seis tonos: el máximo que pasa el validador de paleta entre
// TODOS los pares en los dos temas (la separación por daltonismo queda en la
// banda 6-8, legal porque las iniciales son la identidad y el color solo ayuda).
//
// El color se asigna por hash del nombre, así no cambia cuando alguien entra o
// sale del ranking; pero un hash a secas choca (Yconia: tres de cuatro asesores
// caían en el mismo tono). `buildAvatarPalette` resuelve los choques sobre el
// conjunto completo de nombres del proyecto y lo publica por contexto.

const AVATAR_TONES = ["#1d4ed8", "#b45309", "#db2777", "#a21caf", "#0891b2", "#65a30d"] as const

export function advisorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const first = words[0][0] ?? ""
  const second = words.length > 1 ? words[1][0] ?? "" : words[0][1] ?? ""
  return (first + second).toUpperCase()
}

function nameHash(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h
}

/** Un tono por nombre; con hasta seis nombres, sin repetir (sondeo lineal desde el hash). */
export function buildAvatarPalette(names: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<number>()
  for (const name of [...new Set(names)].sort((a, b) => a.localeCompare(b, "es"))) {
    let slot = nameHash(name) % AVATAR_TONES.length
    if (taken.size < AVATAR_TONES.length) while (taken.has(slot)) slot = (slot + 1) % AVATAR_TONES.length
    taken.add(slot)
    out.set(name, AVATAR_TONES[slot])
  }
  return out
}

const AvatarPaletteContext = createContext<Map<string, string> | null>(null)
export const AvatarPaletteProvider = AvatarPaletteContext.Provider

export function useAvatarColor(name: string): string {
  const palette = useContext(AvatarPaletteContext)
  return palette?.get(name) ?? AVATAR_TONES[nameHash(name) % AVATAR_TONES.length]
}

export function AdvisorAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white", className ?? "h-8 w-8 text-xs")}
      style={{ backgroundColor: useAvatarColor(name) }}
      aria-hidden
    >
      {advisorInitials(name)}
    </span>
  )
}

/** La misma carita, en SVG, para dibujarla encima de una barra de Recharts. */
export function AvatarGlyph({ name, cx, cy, r }: { name: string; cx: number; cy: number; r: number }) {
  return (
    <g aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill={useAvatarColor(name)} />
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={r * 0.85} fontWeight={600} fill="#fff">
        {advisorInitials(name)}
      </text>
    </g>
  )
}

export function fmtInt(n: number): string {
  return n.toLocaleString("es-MX", { maximumFractionDigits: 0 })
}

export function fmtMxn(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
}

/** "$3.8M" / "$689k": para etiquetas encima de barras, donde el monto completo no cabe. */
export function fmtMxnCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toLocaleString("es-MX", { maximumFractionDigits: abs >= 10_000_000 ? 0 : 1 })}M`
  if (abs >= 1_000) return `$${(n / 1_000).toLocaleString("es-MX", { maximumFractionDigits: 0 })}k`
  return `$${n.toLocaleString("es-MX", { maximumFractionDigits: 0 })}`
}

export function fmtPct(r: number | null, digits = 0): string {
  if (r === null || !Number.isFinite(r)) return "—"
  return `${(r * 100).toLocaleString("es-MX", { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`
}

export const CONVERSION_LABELS: { key: keyof PmiConversions; label: string }[] = [
  { key: "leadPerfil", label: "Leads → Perfilamientos" },
  { key: "perfilCita", label: "Perfilamientos → Citas" },
  { key: "citaApartado", label: "Citas → Apartados" },
  { key: "apartadoCierre", label: "Apartados → Cierres" },
]

export function EstimatedNote({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>
        {count} {count === 1 ? "perfilamiento tiene" : "perfilamientos tienen"} fecha estimada: son anteriores al
        arranque de la bitácora y llevan la fecha de su última edición en el CRM. Apartados y cierres salen de los
        campos "Fecha de apartado" y "Fecha de cierre" de la oportunidad y nunca se estiman.
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
