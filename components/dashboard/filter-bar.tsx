"use client"

import * as React from "react"
import { CircleDot, Radio, Target, UserRound, X } from "lucide-react"

import { DateRangeFilter } from "@/components/dashboard/date-range-filter"
import { MultiSelectFilter } from "@/components/dashboard/multi-select-filter"
import type { DateFilter } from "@/lib/date-range"
import {
  EMPTY_FILTERS,
  countActiveFilters,
  hasActiveFilters,
  type DashboardFilters,
  type FilterOptions,
  type StatusKey,
} from "@/lib/dashboard-filters"

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
 * La única barra sticky del panel: fecha + los cuatro filtros de atributo.
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
