"use client"

import * as React from "react"
import { Check, ChevronDown, Search, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
  count: number
}

interface MultiSelectFilterProps {
  label: string
  icon: LucideIcon
  options: MultiSelectOption[]
  selected: string[]
  onChange: (values: string[]) => void
  /**
   * Añade un campo "Buscar" arriba de la lista. Para menús de cardinalidad alta
   * (los nombres de pauta de una cuenta llegan a cientos), donde recorrer la
   * lista a mano no es una opción.
   */
  searchable?: boolean
  /**
   * `compact` alinea el disparador con los controles de 10px del header de una
   * tarjeta (GroupByToggle, TopNSlider); `default` es el de la barra global.
   */
  size?: "default" | "compact"
  /** Deshabilita el disparador sin desmontarlo (el menú vacío ya lo oculta). */
  disabled?: boolean
}

/**
 * Un filtro de selección múltiple. O dentro del filtro (marcar dos asesores trae
 * los de ambos); en la barra global la Y entre filtros la resuelve
 * lib/dashboard-filters.ts, y en un chart el que manda es su propio memo.
 *
 * El disparador lleva su propia etiqueta ("Asesor · 2") en vez de listar los
 * valores elegidos: la barra es sticky y tiene cinco controles, así que un
 * disparador que crece con la selección empujaría a los demás de línea cada vez
 * que alguien marca una casilla. En un header de tarjeta la razón es la misma.
 */
export function MultiSelectFilter({
  label,
  icon: Icon,
  options,
  selected,
  onChange,
  searchable = false,
  size = "default",
  disabled = false,
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const active = selected.length > 0
  const compact = size === "compact"

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    )
  }

  // La búsqueda mira la etiqueta y el valor crudo: en las campañas la etiqueta
  // viene recortada por campaignPrefixCut, así que buscar el prefijo común
  // ("IW - CC") no encontraría nada si sólo miráramos lo que se dibuja.
  const q = query.trim().toLowerCase()
  const visible = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
      )
    : options

  // "Seleccionar todo" actúa sobre lo que la búsqueda dejó a la vista — con un
  // filtro escrito, seleccionar los 400 ocultos sería justo lo contrario de lo
  // que el usuario acaba de pedir.
  const allVisibleSelected =
    visible.length > 0 && visible.every((o) => selected.includes(o.value))

  const toggleAllVisible = () => {
    const visibleValues = visible.map((o) => o.value)
    onChange(
      allVisibleSelected
        ? selected.filter((v) => !visibleValues.includes(v))
        : Array.from(new Set([...selected, ...visibleValues])),
    )
  }

  // Un filtro sin valores posibles en este proyecto no se dibuja: un menú vacío
  // promete un corte que no existe.
  if (options.length === 0) return null

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery("") }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? "default" : "outline"}
          disabled={disabled}
          className={cn(
            "gap-1.5 rounded-md font-medium",
            compact
              ? "h-5 px-1.5 text-[10px] uppercase tracking-wide"
              : "h-7 px-2.5 text-[11px]",
          )}
          aria-label={`Filtrar por ${label}`}
          aria-pressed={active}
        >
          <Icon className={cn("opacity-70", compact ? "h-2.5 w-2.5" : "h-3 w-3")} aria-hidden="true" />
          {label}
          {active && <span className="tabular-nums opacity-80">· {selected.length}</span>}
          <ChevronDown className={cn("opacity-60", compact ? "h-2.5 w-2.5" : "h-3 w-3")} aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className={cn("p-0", compact ? "w-80" : "w-60")}>
        {searchable && (
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar"
              aria-label={`Buscar en ${label}`}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}

        {/* overflow-y-auto plano, no ScrollArea de Radix: rompe `truncate`. */}
        <div className="max-h-72 overflow-y-auto py-1">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              Sin coincidencias
            </p>
          ) : (
            visible.map((opt) => {
              const checked = selected.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => toggle(opt.value)}
                  title={opt.label !== opt.value ? opt.value : undefined}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    {opt.count.toLocaleString("es-MX")}
                  </span>
                </button>
              )
            })
          )}
        </div>

        {(visible.length > 0 || active) && (
          <div className="border-t border-border p-1">
            {visible.length > 0 && (
              <button
                type="button"
                onClick={toggleAllVisible}
                className="w-full rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                {allVisibleSelected ? "Quitar los visibles" : "Seleccionar todo"}
                {q && <span className="opacity-70"> ({visible.length})</span>}
              </button>
            )}
            {active && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                Quitar filtro de {label.toLowerCase()}
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
