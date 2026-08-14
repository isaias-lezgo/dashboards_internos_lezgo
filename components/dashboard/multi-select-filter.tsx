"use client"

import * as React from "react"
import { Check, ChevronDown, type LucideIcon } from "lucide-react"

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
}

/**
 * Un filtro de selección múltiple de la barra global. O dentro del filtro
 * (marcar dos asesores trae los de ambos); la Y entre filtros la resuelve
 * lib/dashboard-filters.ts.
 *
 * El disparador lleva su propia etiqueta ("Asesor · 2") en vez de listar los
 * valores elegidos: la barra es sticky y tiene cinco controles, así que un
 * disparador que crece con la selección empujaría a los demás de línea cada vez
 * que alguien marca una casilla.
 */
export function MultiSelectFilter({
  label,
  icon: Icon,
  options,
  selected,
  onChange,
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false)
  const active = selected.length > 0

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    )
  }

  // Un filtro sin valores posibles en este proyecto no se dibuja: un menú vacío
  // promete un corte que no existe.
  if (options.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? "default" : "outline"}
          className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium"
          aria-label={`Filtrar por ${label}`}
          aria-pressed={active}
        >
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
          {label}
          {active && <span className="tabular-nums opacity-80">· {selected.length}</span>}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-60 p-0">
        {/* overflow-y-auto plano, no ScrollArea de Radix: rompe `truncate`. */}
        <div className="max-h-72 overflow-y-auto py-1">
          {options.map((opt) => {
            const checked = selected.includes(opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => toggle(opt.value)}
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
          })}
        </div>

        {active && (
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              Quitar filtro de {label.toLowerCase()}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
