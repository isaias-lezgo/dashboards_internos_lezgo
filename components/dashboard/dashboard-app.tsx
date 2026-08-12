"use client"

import { useState, useEffect, useMemo } from "react"
import Image from "next/image"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { AnimatePresence } from "framer-motion"
import { MarketingDashboard } from "@/components/dashboard/marketing-dashboard"
import { DateRangeFilter } from "@/components/dashboard/date-range-filter"
import { filterByDateRange, resolveDateRange, type DateFilter } from "@/lib/date-range"
import { format } from "date-fns"
import { es } from "date-fns/locale"
import { SalesDashboard } from "@/components/dashboard/sales-dashboard"
import { ConversationsChat } from "@/components/dashboard/conversations-chat"
import { useDashboardData } from "@/hooks/use-dashboard-data"
import { useConversationsData } from "@/hooks/use-conversations-data"
import {
  TrendingUp,
  BarChart3,
  RefreshCw,
  Loader2,
  AlertCircle,
  Sun,
  Moon,
  Users,
  Target,
  ClipboardList,
  Sparkles,
  LayoutGrid,
  Award,
  Lock,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// Client-only, deliberately. LoadingScreen is a tree of framer-motion elements
// whose `initial` prop (opacity:0, translateX(-8px), …) gets serialised into the
// SSR HTML, but on the client the animations have already advanced past it by the
// time React hydrates — so the style attributes don't match and React reports a
// hydration mismatch. Nothing here is server-renderable anyway: every byte the
// dashboard shows arrives from a client-side fetch, so the SSR pass produced only
// a throwaway loading screen.
//
// Keep this BELOW the import block. Interleaved with the imports, the bundler
// failed to bind `dynamic` and the module threw at evaluation.
const LoadingScreen = dynamic(
  () => import("@/components/dashboard/loading-screen").then((m) => m.LoadingScreen),
  { ssr: false },
)

type DashboardTab = "marketing" | "sales" | "conversations"

// Browser-tab title per view. The app is a single route, so the title is set
// imperatively — `metadata` in layout.tsx can only give one static fallback.
const TAB_TITLES: Record<DashboardTab, string> = {
  marketing: "Marketing - Lezgo Suite CRM",
  sales: "Ventas - Lezgo Suite CRM",
  conversations: "Asistente IA - Lezgo Suite CRM",
}

// With a cache, the age of the data matters more than the clock time it was taken:
// "hace 40 minutos" tells you whether to trust it, "14:32" makes you do the
// subtraction yourself. Anything under a minute reads as current.
function relativeAge(fetchedAt: string, _tick: number): string {
  const mins = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60000)
  if (mins < 1) return "hace un momento"
  if (mins === 1) return "hace 1 minuto"
  if (mins < 60) return `hace ${mins} minutos`
  const hrs = Math.floor(mins / 60)
  if (hrs === 1) return "hace 1 hora"
  if (hrs < 24) return `hace ${hrs} horas`
  const days = Math.floor(hrs / 24)
  return days === 1 ? "hace 1 día" : `hace ${days} días`
}

export function DashboardApp() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [activeTab, setActiveTab] = useState<DashboardTab>("marketing")

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => { document.title = TAB_TITLES[activeTab] }, [activeTab])

  const { data, isLoading, isError, progress, locationName, steps, refresh } = useDashboardData({})

  // The "Actualizado hace X" label is relative, so it has to re-render on its own;
  // without this it would still read "hace un momento" an hour later.
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // The loading screen is for the cold path, which takes tens of seconds. On a warm
  // cache the response lands in about a second, and a screen that flashes in and out
  // reads as a glitch. Delay it: if the data beats the timer, it never shows.
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    if (!isLoading) {
      setShowLoading(false)
      return
    }
    const id = setTimeout(() => setShowLoading(true), 300)
    return () => clearTimeout(id)
  }, [isLoading])
  const { messages } = useConversationsData()

  const [dateFilter, setDateFilter] = useState<DateFilter>({ preset: "all" })
  const dateRange = useMemo(() => resolveDateRange(dateFilter), [dateFilter])

  // Human label of the active date filter, for the PDF report cover.
  const periodLabel = useMemo(() => {
    switch (dateFilter.preset) {
      case "week": return "Últimos 7 días"
      case "month": return "Últimos 30 días"
      case "3m": return "Últimos 3 meses"
      case "6m": return "Últimos 6 meses"
      case "custom":
        if (!dateRange) return "Todo el historial"
        return `${format(dateRange.from, "d MMM yyyy", { locale: es })} – ${format(dateRange.to, "d MMM yyyy", { locale: es })}`
      default: return "Todo el historial"
    }
  }, [dateFilter.preset, dateRange])

  const contacts = useMemo(
    () => filterByDateRange(data?.contacts ?? [], (c) => c.createdAt, dateRange),
    [data?.contacts, dateRange]
  )
  const opportunities = useMemo(
    () => filterByDateRange(data?.opportunities ?? [], (o) => o.createdAt, dateRange),
    [data?.opportunities, dateRange]
  )
  const calls = useMemo(
    () => filterByDateRange(data?.calls ?? [], (c) => c.createdAt, dateRange),
    [data?.calls, dateRange]
  )
  const appointments = useMemo(
    () => filterByDateRange(data?.appointments ?? [], (a) => a.startTime, dateRange),
    [data?.appointments, dateRange]
  )
  const tasks = useMemo(
    () => filterByDateRange(data?.tasks ?? [], (t) => t.createdAt ?? t.dueDate, dateRange),
    [data?.tasks, dateRange]
  )
  const pautas = useMemo(
    () => filterByDateRange(data?.pautas ?? [], (p) => p.createdAt, dateRange),
    [data?.pautas, dateRange]
  )
  const filteredMessages = useMemo(
    () => filterByDateRange(messages, (m) => m.createdAt, dateRange),
    [messages, dateRange]
  )
  const availableMembers = data?.members ?? []
  const availableTags = data?.tags ?? []

  // showLoading, not isLoading: a warm cache read lands in about a second, and a
  // loading screen that flashes in and out reads as a glitch. On the cold path the
  // 300 ms delay is invisible against a sync of tens of seconds.
  const isInitialLoad = showLoading && !data

  return (
    <>
    <AnimatePresence>
      {isInitialLoad && <LoadingScreen key="loader" progress={progress} locationName={locationName} steps={steps} />}
    </AnimatePresence>
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="border-b border-[#335577]/20 bg-[#0D172F] px-4 py-3 text-white shadow-none sm:px-6 sm:py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/logo-mark.png"
              alt="Lezgo Suite"
              width={2851}
              height={3371}
              priority
              className="h-9 w-auto shrink-0"
            />
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">Lezgo Suite Analíticas</h1>
              <p className="text-[11px] font-medium tracking-wide text-white/55">Marketing y Ventas</p>
            </div>
            {locationName && (
              <>
                <span aria-hidden className="hidden h-6 w-px shrink-0 bg-white/15 sm:block" />
                <span className="hidden min-w-0 max-w-[220px] truncate text-[13px] font-medium text-white/80 sm:inline-block">
                  {locationName}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            {isError && (
              <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                Error al cargar datos
              </div>
            )}
            {!isLoading && data && (
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <Users className="h-3 w-3 text-white/45" />
                        {data.contacts.length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Contactos cargados</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <Target className="h-3 w-3 text-white/45" />
                        {data.opportunities.length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Oportunidades cargadas</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1 rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] font-medium tabular-nums text-white">
                        <ClipboardList className="h-3 w-3 text-white/45" />
                        {(data?.pautas ?? []).length.toLocaleString("es-MX")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Pautas cargadas</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            )}
            <span className="hidden text-[11px] tabular-nums text-white/55 sm:inline">
              {isLoading
                ? (progress || "Sincronizando…")
                : data?.meta?.fetchedAt
                  ? `Actualizado ${relativeAge(data.meta.fetchedAt, nowTick)}`
                  : ""}
            </span>
            
           
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 rounded-lg text-xs font-medium"
              onClick={() => refresh()}
              disabled={isLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Actualizar</span>
            </Button>
            
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-white/80" />}

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Cambiar tema"
            >
              {mounted && resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
              onClick={async () => {
                await fetch("/api/project/clear", { method: "POST" })
                // A full page load, not a router push: this drops all client-side
                // dashboard state, so the next project opened in this browser
                // can't show the previous project's data behind a cached React tree.
                window.location.href = "/"
              }}
              aria-label="Cambiar proyecto"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <nav className="border-b border-border bg-card px-4 sm:px-6" aria-label="Vistas del panel">
        <div className="flex gap-6 sm:gap-8">
          {(
            [
              { id: "marketing" as const, label: "Marketing", icon: TrendingUp, locked: false },
              { id: "sales" as const, label: "Ventas", icon: BarChart3, locked: false },
              { id: "conversations" as const, label: "Asistente IA", icon: Sparkles, locked: false },
              { id: "advisors" as const, label: "Asesores", icon: Award, locked: true },
            ] as const
          ).map(({ id, label, icon: Icon, locked }) => {
            if (locked) {
              return (
                <TooltipProvider key={id} delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        aria-disabled
                        className="relative flex cursor-not-allowed items-center gap-2 py-3 text-sm font-medium text-muted-foreground/50"
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {label}
                        <Lock className="h-3 w-3 shrink-0" aria-hidden />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Próximamente</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            }
            const active = activeTab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  "relative flex items-center gap-2 py-3 text-sm font-medium transition-colors duration-200",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
                {active && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            )
          })}
        </div>
      </nav>

      {activeTab !== "conversations" && (
        <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
      )}

      {/* Dashboard Content */}
      <div className="flex-1 pt-2 pb-6">
        {activeTab === "marketing" && (
          <MarketingDashboard
            opportunities={opportunities}
            allOpportunities={data?.opportunities ?? []}
            contacts={contacts}
            allContacts={data?.contacts ?? []}
            pautas={pautas}
            allPautas={data?.pautas ?? []}
            pipelines={data?.pipelines ?? []}
            tasks={tasks}
            calls={calls}
            appointments={appointments}
            allAppointments={data?.appointments ?? []}
            locationId={data?.locationId ?? ""}
            locationName={locationName ?? undefined}
            periodLabel={periodLabel}
          />
        )}
        {activeTab === "sales" && (
          <SalesDashboard
            opportunities={opportunities}
            allOpportunities={data?.opportunities ?? []}
            contacts={contacts}
            allContacts={data?.contacts ?? []}
            calls={calls}
            messages={filteredMessages}
            allMessages={messages}
            appointments={appointments}
            allAppointments={data?.appointments ?? []}
            pipelines={data?.pipelines ?? []}
            tasks={tasks}
            pautas={pautas}
            members={availableMembers}
            locationId={data?.locationId ?? ""}
            locationName={locationName ?? undefined}
            periodLabel={periodLabel}
          />
        )}
        {/* Kept permanently mounted (hidden when inactive) so the AI chat
            history survives switching to the Marketing/Ventas tabs. */}
        {/* The AI assistant always sees the full (unfiltered) dataset — the
            date filter bar is hidden on this tab. */}
        <div className={cn(activeTab !== "conversations" && "hidden")}>
          <ConversationsChat
            dataset={{
              contacts: data?.contacts ?? [],
              opportunities: data?.opportunities ?? [],
              pautas: data?.pautas ?? [],
              appointments: data?.appointments ?? [],
              messages,
              tasks: data?.tasks ?? [],
              calls: data?.calls ?? [],
              customFieldDefs: data?.customFieldDefs ?? [],
            }}
            locationId={data?.locationId}
          />
        </div>
      </div>
    </div>
    </>
  )
}
