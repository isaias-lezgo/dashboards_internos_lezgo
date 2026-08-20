"use client"

import * as React from "react"
import {
  Building2,
  CircleDot,
  MapPin,
  Megaphone,
  Radio,
  Target,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react"

import { DateRangeFilter } from "@/components/dashboard/date-range-filter"
import { MultiSelectFilter } from "@/components/dashboard/multi-select-filter"
import { ToggleFilter } from "@/components/dashboard/toggle-filter"
import type { DateFilter } from "@/lib/date-range"
import {
  EMPTY_FILTERS,
  SEGMENT_DEFS,
  countActiveFilters,
  hasActiveFilters,
  type DashboardFilters,
  type FilterOptions,
  type StatusKey,
} from "@/lib/dashboard-filters"

/**
 * El icono de cada criterio por segmento. Vive aquí y no en `SEGMENT_DEFS` para
 * que lib/dashboard-filters.ts siga siendo puro: es un módulo que corre en el
 * script de verificación, y arrastrar lucide-react a él lo ataría a React.
 * Un criterio sin entrada cae en un icono genérico en vez de romper.
 */
const SEGMENT_ICONS: Record<string, LucideIcon> = {
  plaza: MapPin,
  agencia: Building2,
}

interface FilterBarProps {
  dateFilter: DateFilter
  onDateChange: (value: DateFilter) => void
  filters: DashboardFilters
  onFiltersChange: (value: DashboardFilters) => void
  options: FilterOptions
  /** Oportunidades que sobrevivieron / las que había antes de los filtros. */
  shown: number
  total: number
}

/**
 * La única barra sticky del panel: fecha, los cuatro filtros de atributo, y los
 * criterios que sólo existen en algunas sub-cuentas (Plaza, Agencia, el toggle de
 * Montse). Estos últimos se dibujan solos donde hay algo que separar: sus menús
 * llegan vacíos en los proyectos que no declararon el campo, y MultiSelectFilter
 * no dibuja un menú vacío.
 *
 * El contador "N de M oportunidades" solo aparece con filtros activos, y existe
 * por una razón concreta: los filtros recortan por contacto, así que una tarjeta
 * puede cambiar de número sin que sea obvio por qué. El contador es la prueba de
 * que hay un corte puesto.
 */
export function FilterBar({
  dateFilter,
  onDateChange,
  filters,
  onFiltersChange,
  options,
  shown,
  total,
}: FilterBarProps) {
  const active = hasActiveFilters(filters)

  const set = <K extends keyof DashboardFilters>(key: K, values: DashboardFilters[K]) =>
    onFiltersChange({ ...filters, [key]: values })

  // `segments` se reemplaza entero en vez de mutarse: EMPTY_FILTERS es un objeto
  // compartido, y escribirle una llave envenenaría el estado inicial de la
  // siguiente sesión del panel.
  const setSegment = (key: string, values: string[]) =>
    onFiltersChange({ ...filters, segments: { ...filters.segments, [key]: values } })

  return (
    <section
      aria-label="Filtros del panel"
      className="sticky top-0 z-40 border-b border-border/60 bg-[hsl(214_30%_92%)]/80 backdrop-blur-md dark:bg-[hsl(222_15%_16%)]/75"
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
        <DateRangeFilter value={dateFilter} onChange={onDateChange} />

        <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border/70 sm:block" />

        <MultiSelectFilter
          label="Status"
          icon={CircleDot}
          options={options.status}
          selected={filters.status}
          onChange={(v) => set("status", v as StatusKey[])}
        />
        <MultiSelectFilter
          label="Asesor"
          icon={UserRound}
          options={options.advisors}
          selected={filters.advisors}
          onChange={(v) => set("advisors", v)}
        />
        <MultiSelectFilter
          label="Origen de lead"
          icon={Target}
          options={options.origins}
          selected={filters.origins}
          onChange={(v) => set("origins", v)}
        />
        <MultiSelectFilter
          label="Tipo de pauta"
          icon={Radio}
          options={options.pautaTypes}
          selected={filters.pautaTypes}
          onChange={(v) => set("pautaTypes", v)}
        />

        {SEGMENT_DEFS.map((def) => (
          <MultiSelectFilter
            key={def.key}
            label={def.label}
            icon={SEGMENT_ICONS[def.key] ?? Target}
            options={options.segments[def.key] ?? []}
            selected={filters.segments[def.key] ?? []}
            onChange={(v) => setSegment(def.key, v)}
          />
        ))}

        {options.montse && (
          <ToggleFilter
            label="Campañas Montse"
            icon={Megaphone}
            active={filters.montse}
            onChange={(v) => set("montse", v)}
          />
        )}

        {active && (
          <>
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {shown.toLocaleString("es-MX")} de {total.toLocaleString("es-MX")} oportunidades
            </span>
            <button
              type="button"
              onClick={() => onFiltersChange(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Limpiar {countActiveFilters(filters)}
            </button>
          </>
        )}
      </div>
    </section>
  )
}
