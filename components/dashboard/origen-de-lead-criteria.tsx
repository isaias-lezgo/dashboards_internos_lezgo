"use client"

import { Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// Single source of truth for the "Origen de lead" classification standard.
// Two charts surface this: "Oportunidades por fuente" (rows = Plataforma,
// segments = Fuente de creación) and "Pautas por canal de contacto" (stacked
// by Plataforma). Keep the copy here so both stay in lockstep.

const PLATAFORMA_RULES: { label: string; rule: string }[] = [
  { label: "Instagram", rule: 'URL contiene instagram.com o fuente incluye "instagram"' },
  { label: "Facebook",  rule: 'URL contiene fb.me / facebook.com, fuente incluye "facebook", "meta", "fb" o es un ID numérico largo' },
  { label: "TikTok",    rule: 'fuente incluye "tiktok"' },
  { label: "Google",    rule: 'fuente incluye "google", "bing" o "yahoo"' },
  { label: "Otro",      rule: "no cumple ninguno de los anteriores ni los fallbacks" },
]

// If the primary signals above don't resolve a platform, a fallback cascade
// probes additional origin hints (strongest → weakest) before settling on "Otro".
const FALLBACK_RULES: { label: string; rule: string }[] = [
  { label: "1. Origen de Lead", rule: 'campo del contacto "Origen de Lead" (Instagram/Facebook/TikTok…)' },
  { label: "2. Campos de la oportunidad", rule: 'Origen de Lead / Tipo de pauta / Nombre pauta — lead del sitio web con "Tipo de pauta = Google Ads" → Google; sitio web orgánico (sin pauta) se queda en Otro en plataforma' },
  { label: "3. Medio",          rule: "medio de atribución de Lezgo Suite CRM (facebook, instagram, tiktok…)" },
  { label: "4. Tipo de anuncio", rule: "utm_medium / utm_session_source" },
  { label: "5. Campaña",        rule: "etiqueta de campaña (utm_content / utm_campaign)" },
  { label: "6. URL / fuente",   rule: "re-escaneo de la URL y fuente completas" },
]

const FUENTE_RULES: { label: string; rule: string }[] = [
  { label: "Publicidad en Meta/TikTok",  rule: "fuente en meta/facebook/instagram/tiktok, medio en paid_social/cpc/cpm, o con ID de anuncio u objeto Pauta (incluye anuncios a WhatsApp)" },
  { label: "Publicidad en Google",       rule: 'fuente/medio en google/bing ads, o campo "Tipo de pauta = Google Ads" (incluye leads del sitio web vía Google Ads)' },
  { label: "Redes Sociales (Orgánico)",  rule: "fuente orgánica en redes sociales sin medio de pago" },
  { label: "Manual (CRM)", rule: "fuente vacía o ingresada manualmente desde el CRM" },
  { label: "Orgánico Web", rule: 'origen del sitio web sin pauta (Sitio Web / Formulario Sitio Web / Web…), o fuente "web"/"website"/"landing" o medio "organic"/"referral"' },
  { label: "Otro",         rule: "fuente no clasificada en los anteriores" },
]

function RuleList({ rules }: { rules: { label: string; rule: string }[] }) {
  return (
    <ul className="space-y-0.5 text-muted-foreground">
      {rules.map((r) => (
        <li key={r.label}>
          <span className="text-foreground">{r.label}</span> — {r.rule}
        </li>
      ))}
    </ul>
  )
}

// ⓘ button + tooltip documenting the Origen-de-lead criteria. Drop into a
// ChartCardHeader `actions` slot.
export function OrigenDeLeadInfo() {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors">
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          collisionPadding={8}
          className="w-[min(28rem,92vw)] max-w-none p-0 text-xs leading-relaxed"
        >
          <div className="max-h-[80vh] space-y-2 overflow-y-auto px-3 py-2">
            <p className="font-semibold text-foreground">Criterios de clasificación</p>
            <div>
              <p className="font-medium text-foreground mb-0.5">Plataforma (filas)</p>
              <RuleList rules={PLATAFORMA_RULES} />
            </div>
            <div>
              <p className="font-medium text-foreground mb-0.5">Fallbacks de plataforma</p>
              <RuleList rules={FALLBACK_RULES} />
            </div>
            <div>
              <p className="font-medium text-foreground mb-0.5">Fuente de creación (segmentos)</p>
              <RuleList rules={FUENTE_RULES} />
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
