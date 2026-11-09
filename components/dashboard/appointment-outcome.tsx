"use client"

// "Resultado de las citas": una barra segmentada por estatus de la cita. Una sola
// copia para Ventas (todas las citas) y Marketing (solo las de leads de pauta) —
// el recorte del universo lo hace quien la usa, no esta tarjeta.

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import type { Appointment } from "@/lib/types"
import type { ReportSection } from "@/lib/report"
import {
  chartPaletteColor,
  DashboardCard,
  ChartCardHeader,
  ChartCardContent,
  ChartEmpty,
  ChartHint,
} from "./dashboard-ui"
import type { ApptDrillState } from "./appointment-drill-drawer"

const APPT_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  showed:    { label: "Asistió",    color: "#10b981" },
  confirmed: { label: "Confirmada", color: "#335577" },
  new:       { label: "Pendiente",  color: "#F59B1B" },
  noshow:    { label: "No asistió", color: "#ef4444" },
  cancelled: { label: "Cancelada",  color: "#94a3b8" },
  invalid:   { label: "Inválida",   color: "#6b7280" },
}

const KNOWN_APPT_STATUS_ORDER = ["showed", "confirmed", "new", "noshow", "cancelled", "invalid"]

function apptStatusVisual(status: string, fallbackIndex: number): { label: string; color: string } {
  const known = APPT_STATUS_CONFIG[status]
  if (known) return known
  return {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    color: chartPaletteColor(fallbackIndex),
  }
}

export interface ApptOutcomeSegment {
  status: string
  appts: Appointment[]
  count: number
  pct: number
  label: string
  color: string
}

/** Un segmento por estatus, en el orden del ciclo de la cita; los desconocidos al final. */
export function buildAppointmentOutcome(appointments: Appointment[]): ApptOutcomeSegment[] {
  const byStatus = new Map<string, Appointment[]>()
  for (const a of appointments) {
    if (!byStatus.has(a.status)) byStatus.set(a.status, [])
    byStatus.get(a.status)!.push(a)
  }
  const statuses = [...byStatus.keys()].sort((a, b) => {
    const ai = KNOWN_APPT_STATUS_ORDER.indexOf(a)
    const bi = KNOWN_APPT_STATUS_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
  return statuses.map((status, i) => {
    const appts = byStatus.get(status)!
    return {
      status,
      appts,
      count: appts.length,
      pct: appointments.length > 0 ? (appts.length / appointments.length) * 100 : 0,
      ...apptStatusVisual(status, i),
    }
  })
}

/** La sección del PDF: la misma partición que la barra, como pastel. */
export function buildAppointmentOutcomeReportSection({
  id,
  title,
  explanation,
  segments,
}: {
  id: string
  title: string
  explanation: string
  segments: ApptOutcomeSegment[]
}): ReportSection | null {
  if (segments.length === 0) return null
  const total = segments.reduce((s, seg) => s + seg.count, 0)
  return {
    id,
    title,
    explanation,
    blocks: [{
      t: "chart", type: "pie", valueLabel: "Citas",
      title: `Citas (total: ${total})`,
      series: segments.map((s) => ({ label: s.label, value: s.count })),
    }],
  }
}

export function AppointmentOutcomeCard({
  segments,
  onDrill,
  drillTitle = "Citas",
  actions,
  icon,
  emptyMessage = "Sin citas para mostrar",
}: {
  segments: ApptOutcomeSegment[]
  onDrill: (d: ApptDrillState) => void
  /** Prefijo del título del drawer: "<drillTitle> · <estatus>". */
  drillTitle?: string
  actions?: ReactNode
  icon?: LucideIcon
  emptyMessage?: string
}) {
  const total = segments.reduce((s, seg) => s + seg.count, 0)
  return (
    <DashboardCard>
      <ChartCardHeader title="Resultado de las citas" total={total} icon={icon} actions={actions} />
      <ChartCardContent>
        {segments.length === 0 ? (
          <ChartEmpty message={emptyMessage} height={96} />
        ) : (
          <>
            <div className="flex h-14 w-full gap-0.5 overflow-hidden rounded-lg">
              {segments.map((seg) => (
                <button
                  key={seg.status}
                  type="button"
                  className="flex min-w-[84px] flex-col justify-center px-3 text-left text-white transition-[filter] hover:brightness-110"
                  style={{ flexGrow: seg.count, flexBasis: 0, background: seg.color }}
                  onClick={() =>
                    onDrill({
                      open: true,
                      title: `${drillTitle} · ${seg.label}`,
                      appointments: seg.appts,
                    })
                  }
                >
                  <span className="text-base font-bold leading-none tabular-nums">{seg.count}</span>
                  <span className="mt-1 truncate text-[10px] font-medium opacity-90">
                    {seg.label} · {seg.pct.toFixed(0)}%
                  </span>
                </button>
              ))}
            </div>
            <ChartHint>Ancho proporcional al volumen · Haz clic en un segmento para ver las citas</ChartHint>
          </>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}
