"use client"

import type { CSSProperties } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { PMI_CONVERSION_TARGETS, semaphore, type PmiConversions, type PmiCounts, type PmiIndicator, type PmiObjectives } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { AdvisorAvatar, INDICATOR_LABELS, conversionTone, fmtInt, fmtMxn, fmtPct, toneClass } from "./pmi-ui"

// El embudo del PMI: los cinco hitos del mes como escalones que se estrechan,
// con la conversión entre cada par. Reemplaza a los cinco tiles y la tira de
// conversiones, que eran la misma información en dos piezas.
//
// La silueta NO codifica el dato. Con 16 leads y 1 perfilamiento un embudo
// proporcional desaparece a partir del segundo escalón, así que los anchos son
// fijos; lo que sí se mide es el relleno de cada escalón: su avance contra el
// objetivo del mes, teñido con el semáforo.

const STAGES: { kind: PmiIndicator; width: string; conversion: keyof PmiConversions | null }[] = [
  { kind: "leads", width: "100%", conversion: "leadPerfil" },
  { kind: "perfilamientos", width: "88%", conversion: "perfilCita" },
  { kind: "citas", width: "76%", conversion: "citaApartado" },
  { kind: "apartados", width: "64%", conversion: "apartadoCierre" },
  { kind: "cierres", width: "52%", conversion: null },
]

const CONVERSION_SHORT: Record<keyof PmiConversions, string> = {
  leadPerfil: "Leads a perfilamientos",
  perfilCita: "Perfilamientos a citas",
  citaApartado: "Citas a apartados",
  apartadoCierre: "Apartados a cierres",
}

// El relleno del escalón usa el semáforo como fondo tenue; el texto se queda en
// tinta normal para que el color nunca sea lo único que dice cómo va.
function fillClass(tone: ReturnType<typeof semaphore>): string {
  switch (tone) {
    case "alto": return "bg-emerald-500/18"
    case "medio": return "bg-sky-500/18"
    case "bajo": return "bg-rose-500/18"
    default: return "bg-muted-foreground/8"
  }
}

// El embudo no sabe si el período es un mes o un trimestre: recibe el total,
// el objetivo del período y las conversiones, y `periodNote` dice de dónde
// salió ese objetivo.
export function PmiFunnel({
  total, objective, conversions: conv, periodNote, scopeTitle, advisorName, onStage,
}: {
  total: PmiCounts
  objective: PmiObjectives
  conversions: PmiConversions
  periodNote: string
  scopeTitle: string
  /** Con nombre se dibuja su avatar en la cabecera: el embudo es de una persona. */
  advisorName?: string
  onStage: (kind: PmiIndicator, ids: string[]) => void
}) {
  const t = total
  const o = objective
  const money = (kind: PmiIndicator) => (kind === "apartados" ? t.montoApartados : kind === "cierres" ? t.montoCierres : null)
  const moneyObjective = (kind: PmiIndicator) => (kind === "apartados" ? o.montoApartados : kind === "cierres" ? o.montoCierres : null)

  return (
    <DashboardCard className="flex h-full flex-col">
      <ChartCardHeader
        title={advisorName ? `Embudo · ${advisorName}` : `Embudo · ${scopeTitle}`}
        actions={
          <>
            {advisorName && <AdvisorAvatar name={advisorName} className="h-7 w-7 text-[11px]" />}
            <ScopePill label="Objetivos"
              tooltip={`Objetivos fijos por asesor y mes: leads 40, perfilamientos 16, citas 8, apartados 2 / $3M, cierres 2 / $3M. ${periodNote} El relleno de cada escalón es el avance contra ese objetivo (en apartados y cierres, por monto).`} />
          </>
        }
      />
      <ChartCardContent className="flex flex-1">
        {/* Los escalones se reparten la altura de la tarjeta, que la fija la columna vecina. */}
        <ol className="flex w-full flex-1 flex-col items-center justify-around gap-1">
          {STAGES.map(({ kind, width, conversion }) => {
            const value = t[kind]
            const ids = t.ids[kind]
            const m = money(kind)
            const mo = moneyObjective(kind)
            // Apartados y cierres se miden por monto, como en el Excel; los demás por conteo.
            const measured = m !== null && mo !== null ? m : value
            const objective = m !== null && mo !== null ? mo : o[kind]
            const avance = objective > 0 ? measured / objective : null
            const tone = avance === null ? null : semaphore(avance, 1)
            const fillPct = avance === null ? 0 : Math.min(1, avance) * 100
            const convValue = conversion ? conv[conversion] : null
            const convTarget = conversion ? PMI_CONVERSION_TARGETS[conversion] : 0
            return (
              <li key={kind} className="flex w-full flex-col items-center gap-1">
                <button
                  type="button"
                  disabled={ids.length === 0}
                  onClick={() => onStage(kind, ids)}
                  // En móvil todos los escalones van a todo lo ancho: la
                  // silueta no vale lo que cuesta recortar el texto.
                  style={{ "--stage": width } as CSSProperties}
                  className={cn(
                    "relative w-full overflow-hidden rounded-lg border border-border bg-card text-left transition-[border-color] sm:w-[var(--stage)]",
                    ids.length > 0
                      ? "cursor-pointer hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      : "cursor-default",
                  )}
                  aria-label={`${INDICATOR_LABELS[kind]}: ${fmtInt(value)}, objetivo ${fmtInt(o[kind])}`}
                >
                  <span aria-hidden className={cn("absolute inset-y-0 left-0", fillClass(tone))} style={{ width: `${fillPct}%` }} />
                  <span className="relative flex items-center gap-3 px-3 py-2.5">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{INDICATOR_LABELS[kind]}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {kind === "leads" && `${fmtInt(t.leadsPauta)} de pauta · `}
                        {m !== null && `${fmtMxn(m)} · `}
                        objetivo {fmtInt(o[kind])}{mo !== null && ` · ${fmtMxn(mo)}`}
                      </span>
                    </span>
                    <span className="text-2xl font-semibold tabular-nums leading-none">{fmtInt(value)}</span>
                    <span className={cn("w-14 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums", toneClass(tone))}>
                      {fmtPct(avance)}
                    </span>
                  </span>
                </button>
                {conversion && (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ChevronDown className="h-3 w-3" aria-hidden />
                    <span>{CONVERSION_SHORT[conversion]}</span>
                    <span className={cn("rounded px-1.5 py-px font-semibold tabular-nums", toneClass(conversionTone(convValue, convTarget)))}>{fmtPct(convValue)}</span>
                    <span>meta {fmtPct(convTarget)}</span>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </ChartCardContent>
    </DashboardCard>
  )
}
