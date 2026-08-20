"use client"

import * as React from "react"
import { Check, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

interface ToggleFilterProps {
  label: string
  icon: LucideIcon
  active: boolean
  onChange: (active: boolean) => void
}

/**
 * Un filtro de encendido/apagado de la barra global. Deliberadamente NO usa
 * `components/ui/switch`: la barra es una fila de píldoras, y meter un riel
 * deslizante entre ellas rompería la lectura de "estos son controles del mismo
 * tipo". Comparte el disparador exacto de MultiSelectFilter, menos el menú.
 *
 * Apagado no excluye nada — es un recorte, no una partición —, así que el estado
 * neutro es el de contorno y el activo el sólido, igual que en los demás.
 */
export function ToggleFilter({ label, icon: Icon, active, onChange }: ToggleFilterProps) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium"
      aria-label={`Filtrar por ${label}`}
      aria-pressed={active}
      onClick={() => onChange(!active)}
    >
      <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
      {label}
      {active && <Check className="h-3 w-3 opacity-80" strokeWidth={3} aria-hidden="true" />}
    </Button>
  )
}
