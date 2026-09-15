"use client"

import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Appointment, Call, Contact, Message, Opportunity, Pauta, Task } from "@/lib/types"
import {
  buildPmiMonth, buildPmiYear, currentMonth, monthLabel, shiftMonth,
  type PmiIndicator, type PmiSlice,
} from "@/lib/pmi"
import { DashboardShell, ScopePill } from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { ConversionStrip, EstimatedNote, INDICATOR_LABELS, PmiSection, PmiTile, fmtInt, fmtMxn } from "./pmi-ui"
import { PmiWeekTable } from "./pmi-week-table"

interface PmiDashboardProps {
  contacts: Contact[]
  opportunities: Opportunity[]
  appointments: Appointment[]
  pautas: Pauta[]
  tasks: Task[]
  calls: Call[]
  messages: Message[]
  locationId: string
  locationName?: string
}

type PmiView = "month" | "year"
const TEAM = "__team__"

// Las reglas de cada indicador, en una sola copia para los ScopePill y el PDF.
export const PMI_RULES = {
  leads: "Todo contacto nuevo asignado al asesor en el período, venga de donde venga; abajo, cuántos son de pauta.",
  perfilamientos: "Primera vez que la oportunidad llegó a Cliente Calificado o una etapa posterior. Las perdidas cuentan por su última etapa.",
  citas: "Citas de calendario con estado 'showed' (el lead sí fue), por su fecha.",
  apartados: "Primera vez que la oportunidad llegó a Apartado o una etapa posterior. Un apartado que después se cae sigue contando en su mes.",
  cierres: "Primera vez que la oportunidad llegó a Proceso de Escritura, Siguiente Escritura, Negocio Ganado o Entregado.",
} as const

export function PmiDashboard(props: PmiDashboardProps) {
  const { contacts, opportunities, appointments, pautas, tasks, calls, messages, locationId } = props
  const [view, setView] = useState<PmiView>("month")
  const [month, setMonth] = useState(() => currentMonth())
  const [advisor, setAdvisor] = useState<string>(TEAM)
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)

  const input = useMemo(
    () => ({ contacts, opportunities, appointments, pautas }),
    [contacts, opportunities, appointments, pautas],
  )
  const pmi = useMemo(() => buildPmiMonth(input, month), [input, month])
  const year = Number(month.slice(0, 4))
  const pmiYear = useMemo(() => (view === "year" ? buildPmiYear(input, year) : null), [input, year, view])

  const advisorNames = pmi.advisors.map((a) => a.name)
  const selected = advisor === TEAM ? null : pmi.advisors.find((a) => a.name === advisor) ?? null
  const slice: PmiSlice = selected ?? pmi.team

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])

  // Un solo camino de drill: por indicador, con los ids que el motor guardó.
  const openDrill = useCallback(
    (kind: PmiIndicator, ids: string[], title: string, subtitle?: string) => {
      if (kind === "leads") {
        const items = ids.map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      if (kind === "citas") {
        const wanted = new Set(ids)
        const byContact = new Set(appointments.filter((a) => wanted.has(a.id)).map((a) => a.contactId))
        const items = [...byContact].map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      const opps = ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => Boolean(o))
      setDrill({ open: true, title, subtitle, opportunities: opps })
    },
    [appointments, contactById, oppById],
  )

  const periodTitle = view === "year" ? String(year) : monthLabel(month)
  const scopeTitle = selected ? selected.name : "Equipo"
  const o = slice.objectives.month
  const t = slice.total
  const avance = (value: number, objective: number) => (objective > 0 ? value / objective : null)

  return (
    <DashboardShell>
      {/* Cabecera propia: el PMI es mensual por construcción, la barra global no aplica */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período anterior"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? -12 : -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold tabular-nums">{periodTitle}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período siguiente"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? 12 : 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["month", "year"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 font-medium transition-colors", view === v ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "month" ? "Mes" : "Año"}
            </button>
          ))}
        </div>
        {view === "month" && (
          <div className="flex flex-wrap gap-1 text-xs">
            {[TEAM, ...advisorNames].map((name) => (
              <button key={name} type="button" onClick={() => setAdvisor(name)}
                className={cn("rounded-full border px-3 py-1 font-medium transition-colors",
                  advisor === name ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                {name === TEAM ? "Equipo" : name}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto" data-slot="pmi-export" />
      </div>

      {view === "month" && (
        <>
          <EstimatedNote count={pmi.estimatedCount} />
          <PmiSection title={`${scopeTitle} · ${monthLabel(month)}`}
            hint={<ScopePill label="Objetivos" tooltip="Objetivos fijos por asesor y mes: leads 40, perfilamientos 16, citas 8, apartados 2 / $3M, cierres 2 / $3M. El equipo suma un objetivo por asesor con actividad en el mes." />}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <PmiTile label="Leads" value={fmtInt(t.leads)} sub={`${fmtInt(t.leadsPauta)} de pauta`}
                objective={fmtInt(o.leads)} avance={avance(t.leads, o.leads)}
                onClick={() => openDrill("leads", t.ids.leads, `Leads · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Perfilamientos" value={fmtInt(t.perfilamientos)}
                objective={fmtInt(o.perfilamientos)} avance={avance(t.perfilamientos, o.perfilamientos)}
                onClick={() => openDrill("perfilamientos", t.ids.perfilamientos, `Perfilamientos · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Citas efectivas" value={fmtInt(t.citas)}
                objective={fmtInt(o.citas)} avance={avance(t.citas, o.citas)}
                onClick={() => openDrill("citas", t.ids.citas, `Citas efectivas · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Apartados" value={fmtInt(t.apartados)} sub={fmtMxn(t.montoApartados)}
                objective={`${fmtInt(o.apartados)} · ${fmtMxn(o.montoApartados)}`} avance={avance(t.montoApartados, o.montoApartados)}
                onClick={() => openDrill("apartados", t.ids.apartados, `Apartados · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Cierres" value={fmtInt(t.cierres)} sub={fmtMxn(t.montoCierres)}
                objective={`${fmtInt(o.cierres)} · ${fmtMxn(o.montoCierres)}`} avance={avance(t.montoCierres, o.montoCierres)}
                onClick={() => openDrill("cierres", t.ids.cierres, `Cierres · ${scopeTitle}`, monthLabel(month))} />
            </div>
          </PmiSection>

          <PmiSection title="Conversiones"
            hint={<ScopePill label="Metas" tooltip="Metas de conversión del PMI: 40 % / 60 % / 75 % / 100 %. Sin denominador la conversión se muestra como —, no como 0 %." />}>
            <ConversionStrip conversions={slice.conversions} />
          </PmiSection>
          <PmiWeekTable
            slice={slice}
            weeks={pmi.weeks}
            onCell={(kind, ids, weekLabel) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, `${weekLabel} · ${monthLabel(month)}`)}
          />
          {/* Task 10–11 */}
        </>
      )}

      {view === "year" && pmiYear && (
        <>
          <EstimatedNote count={pmiYear.estimatedCount} />
          {/* Task 12 agrega aquí la vista anual */}
        </>
      )}

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={opportunities}
        allPautas={pautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardShell>
  )
}

export { INDICATOR_LABELS }
