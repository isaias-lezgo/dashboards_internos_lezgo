# Meta Ads ②: "Inversión en pauta" en Marketing, en el PDF y en el Asistente IA

Fecha: 2026-09-14
Estado: diseño aprobado para implementar
Depende de: ① (`2026-09-14-meta-ads-conexion-y-sync-design.md`), en producción desde
hoy. `DashboardPayload.metaAds` / `metaAdsStatus` y `lib/meta-attribution.ts`
(`buildMetaIndex`, `classifyLead`, `buildCostSummary`, `buildCampaignPerformance`)
ya existen; esta entrega los **muestra**.

## El problema

El gasto ya viaja en el payload y cruza con las oportunidades por ad id, pero nadie lo
ve: ni en Marketing, ni en el PDF, ni el asistente sabe que existe. La pregunta de
negocio — *cuánto costó cada lead y cada venta, por campaña* — sigue sin respuesta en
pantalla.

## Decisiones

1. **Una sección "Inversión en pauta" arriba de Marketing**, debajo de los tres tiles
   de resumen y antes de las gráficas. Es la pregunta de dinero. Rechazado: al final de
   la página (invisible en la práctica); pestaña propia (dos lugares para la misma
   campaña; ya decidido en ①).
2. **Sin `metaAds` la sección no se dibuja.** La píldora del header ya es el llamado a
   conectar; un placeholder "conecta Meta" duplicaría ese mensaje en cada proyecto sin
   cuenta, incluidos los de agencias que no pueden conectar.
3. **Las gráficas existentes no cambian.** Una gráfica de gasto por mes queda fuera:
   la tabla y el asistente lo cubren, y cada gráfica nueva es un drawer y una sección
   de PDF más.
4. **Un solo motor de reporte** para panel y asistente: `buildMetaReport()` generaliza
   `buildCampaignPerformance` a cualquier `groupBy`. La tabla del panel es
   `groupBy: "campaign"`; la herramienta del asistente expone todos.
5. **El gasto no se recorta por atributo.** Con Asesor/Status/Origen/Tipo de pauta
   activos, `gasto ÷ leads de un asesor` sería un CPL falso. Se muestran Leads CRM y
   Ganadas recortados y **CPL/CPA en `—`** con la explicación en el `ScopePill`.
6. **El lead es el CONTACTO, no la oportunidad** (revisión 2026-09-14, tras ver
   "248 leads contra 2,354 de Meta" en Lezgo Suite: 5,477 contactos, 404
   oportunidades — la mayoría de los leads nunca llega a oportunidad). El ad id de un
   contacto se resuelve con la cadena **oportunidad → objeto Pauta del contacto →
   primera atribución → última atribución**; cada eslabón cuenta solo si su id está
   en Meta. El objeto Pauta aporta su id porque `nombrePauta` termina en él
   (`<titular> - <liga> - <adId>`). Medido: 246 + 1,021 + 408 + 2 = 1,677 contactos,
   71 % de lo que Meta reporta, 75-85 % mes a mes desde que existe el objeto Pauta.
   Las oportunidades (propio ad id, o el de su contacto) y las ganadas son el embudo
   debajo: **CPL = gasto ÷ contactos, CPA = gasto ÷ ganadas**. Un tile más
   ("Oportunidades") y una columna más ("Opps") en la tabla, el PDF y la herramienta.

---

## Marketing — `components/dashboard/meta-investment-section.tsx`

Componente nuevo (`SummaryTile` pasa a exportarse de `dashboard-ui.tsx`), montado en `marketing-dashboard.tsx` después de
`<MarketingSummaryStrip>`. Recibe:

```ts
{
  metaAds: MetaAdsData          // no null: el padre no lo monta si falta
  metaAdsStatus?: MetaAdsStatus
  opportunities: Opportunity[]  // las FILTRADAS (fecha + atributos)
  allOpportunities: Opportunity[]
  pautas: Pauta[]               // para pautaContacts (isDePauta)
  dateRange: ResolvedDateRange | null
  attributeFiltersActive: boolean
  onDrill: (d: DrillState) => void
}
```

`MarketingDashboard` gana tres props que `dashboard-app.tsx` ya tiene a la mano:
`metaAds`, `metaAdsStatus`, `dateRange`; `attributeFiltersActive` se deriva de
`filtersLabel !== undefined`.

**Cálculo.** `range = dateRange ? { since: localDay(from), until: localDay(to) } :
null` — el mismo día local con el que el filtro recortó las oportunidades. El índice
se memoiza por referencia de `metaAds`. `buildCostSummary` y `buildMetaReport` reciben
`opportunities` (filtradas) — como `range` se vuelve a aplicar adentro, pasar las
filtradas no cambia el resultado por fecha y sí aplica los atributos al lado CRM.

**Fila de seis tiles** (`SummaryTile`, mismo componente de `dashboard-ui.tsx`):

| Tile | Valor | Subtexto | Clic |
|---|---|---|---|
| Gasto | `spend` en moneda de la cuenta (`$12,825.99 MXN`) | ventana en días locales | abre la tabla (scroll) |
| Leads CRM | `leadsCrm` (contactos) | "Meta reportó `leadsMeta`" | drawer: los contactos `exact` de la ventana |
| CPL | `cpl` o `—` | "por lead del CRM" | ídem |
| Oportunidades | `opportunities` | `opps/leadsCrm` % | drawer: las opps `exact` |
| Ganadas | `won` | `won/opportunities` % | drawer: las ganadas |
| CPA | `cpa` o `—` | "por venta" | ídem |

Debajo, una **línea de rendimiento** en texto pequeño: `Impresiones · Clics · CPM ·
CTR` (los cuatro con `mixedCurrency` aparte: CPM en `—`). `unknownAdLeads > 0` agrega
"N leads con anuncio fuera de las cuentas asignadas" al `ScopePill`.

**`ScopePill`** del encabezado de sección: "Cohorte por fecha de creación. El gasto sigue
solo al filtro de fecha; los filtros de atributo recortan leads y ganadas." Con
atributos activos añade "— CPL y CPA no se calculan". Con `metaAdsStatus.partial`:
"Cuenta X no respondió en el último sync". Con `error`: "Gasto del último sync bueno".

**Tabla "Gasto y costo por campaña"** (`components/ui/table`, dentro de un
`overflow-x-auto`, nunca `ScrollArea`): columnas Campaña · Gasto · Impr. · Clics · CPM ·
CTR · Leads Meta · Leads CRM · Opps · Ganadas · CPL · CPA; ordenada por gasto desc; **Top N**
con el slider que ya usan las gráficas (`visibleGroupKeys`, default 10); fila
"Otras (N)" con la suma del resto. Clic en una fila → `onDrill` con los contactos `exact` de
esa campaña (agrupados en el hook sin el tope de 50 ids). Números con
`toLocaleString("es-MX")`; `null` se pinta `—`, nunca `$0`.

**Moneda mixta**: el tile Gasto lista `spendByCurrency` ("$1,200 MXN · $300 USD"),
CPL/CPA/CPM en `—`, y la tabla muestra cada fila en su moneda.

---

## `lib/meta-attribution.ts` — `buildMetaReport`

```ts
export type MetaGroupBy = "none" | "campaign" | "adset" | "ad" | "month"

export interface MetaReportInput extends CostInput {
  groupBy: MetaGroupBy
  /** Nombre de campaña (case-insensitive, substring) para acotar adset/ad/month. */
  campaign?: string
  includeIds?: boolean
}

export interface MetaReportRow {
  key: string          // id de campaña/adset/ad, "YYYY-MM", o "total"
  label: string        // nombre; el mes tal cual
  accountId: string | null
  currency: string     // "?" si mezcla (solo en "none"/"month" con varias cuentas)
  spend: number; impressions: number; clicks: number
  cpm: number | null; ctr: number | null
  leadsMeta: number; leadsCrm: number; won: number
  cpl: number | null; cpa: number | null
  oppIds?: string[]; contactIds?: string[]   // solo con includeIds, cap 50
}

export function buildMetaReport(p: MetaReportInput): MetaReportRow[]
```

- `buildCampaignPerformance` pasa a ser `buildMetaReport({ …, groupBy: "campaign" })`
  y se conserva como alias exportado (el verify existente sigue igual).
- `groupBy: "month"` agrupa `daily.date.slice(0, 7)` y las opps por `localDay(createdAt).slice(0, 7)`.
- Una fila de moneda mixta (`none`/`month` con cuentas en distintas monedas) lleva
  `currency: "?"` y `cpm/cpl/cpa: null`; `spend` se suma igual y la UI lo sabe por
  `currency`.
- Orden: gasto desc, salvo `month` que va cronológico.

`scripts/verify-meta-attribution.ts` crece: `month` con la cohorte cruzando el límite
de mes por día local, `adset`/`ad`, el filtro `campaign`, `includeIds` con el cap, y
`currency: "?"` en moneda mixta.

---

## PDF — `lib/report.ts` / `marketing-dashboard.tsx`

`buildReport()` agrega, **solo si hay `metaAds`**, la sección `meta-investment`
"Inversión en pauta" al principio de `sections`: un bloque `kpis` (los cinco tiles +
Impresiones/Clics/CPM/CTR) y un bloque `table` con las mismas columnas de la tabla,
top 15 campañas. `explanation` fija: "Gasto de Meta Ads en el periodo, cruzado por id
de anuncio con las oportunidades creadas en ese periodo. CPL y CPA usan los leads del
CRM, no los que Meta reporta." Con filtros de atributo activos la explicación añade la
regla de la decisión 5. Los KPIs de portada (`kpis` del `ReportInput`) ganan Gasto y
CPL cuando existen.

Presupuesto: `analyze-report` usa `max_tokens: 8000` para ~13 secciones de marketing;
una sección más cabe (~600 tokens por análisis). Se verifica generando el PDF de Lezgo
Suite con Meta conectado.

---

## Asistente IA

### `buildDatasetSummary` (`lib/ai-context.ts`)

`ChatDataset` gana `metaAds?: MetaAdsData | null` (el chat ya recibe el payload
completo). Con `metaAds`, el resumen añade:

```
=== META ADS ===
Conectado: 1 cuenta (LezgoSuite, MXN). Ventana: 2025-09-01 → 2026-09-14.
Gasto total: $155,634.65 MXN. Por mes: 2025-09 $4,209.98 · 2025-10 $14,352.37 · …
Top campañas por gasto: "CAMPAÑA SEPT | WHA | NUEVO DASHBOARD" $…, …  (8)
Cruce con el CRM: 248 oportunidades con anuncio en Meta (exact), 3 con anuncio fuera
de las cuentas asignadas, 6 de pauta sin ad id.
```

Sin `metaAds`: `=== META ADS === No conectado en este proyecto.` — para que el modelo
lo diga en vez de inventar. El bloque es determinista y estable entre turnos (prompt
caching).

### Herramienta `meta_ads_report` (`lib/ai-tools.ts`)

```
{ groupBy: "none"|"campaign"|"adset"|"ad"|"month", since?: "YYYY-MM-DD",
  until?: "YYYY-MM-DD", campaign?: string, includeContactIds?: boolean, limit?: number }
→ { currency, window, rows: MetaReportRow[] , note?: string }
```

Ejecuta `buildMetaReport` sobre `data.metaAds` + `data.opportunities` (historial
completo) + `pautaContacts` del índice de `ai-index`. Sin `metaAds` devuelve
`{ error: "meta_not_connected" }`. `includeContactIds` alimenta `render_chart` igual que
`aggregate`. Fechas en día local CDMX, la convención de todo el asistente.

### Reglas nuevas en `ASSISTANT_SYSTEM_PROMPT`

Se agregan al final de la lista numerada, con el mismo tono de regresión:

- **Costos SIEMPRE con `meta_ads_report`.** Nunca dividas gasto entre leads a mano
  ni sumes gasto de resultados de otras herramientas.
- **"Leads Meta" ≠ "Leads CRM".** Meta reporta conversiones que cobró; el CRM tiene
  oportunidades reales. CPL y CPA usan CRM. Di cuál reportas.
- **El gasto no se filtra por asesor, origen ni etapa** — solo por fecha y campaña.
  Si piden "CPL de Ana", explica que el gasto es de la campaña, no del asesor.
- **Moneda de la cuenta, sin convertir.** Si `currency` es `"?"`, repórtalo por moneda.
- **Sin Meta conectado, dilo.** El resumen lo indica; no estimes costos.

---

## Verificación

- `pnpm verify:meta-attribution` (ampliado) · `npx tsc --noEmit`.
- Contra realidad en Lezgo Suite (producción): filtrar **julio 2026** → tile Gasto
  `$12,825.99 MXN`; **agosto** `$9,817.97`. Con Asesor activo → CPL/CPA en `—`. Clic en
  Leads CRM → drawer con las opps `exact`. PDF con la sección nueva y su análisis.
  Asistente: "¿cuánto gastamos en julio?" → el mismo número vía `meta_ads_report`;
  "¿qué campaña tuvo el CPL más bajo en agosto?" → una llamada con `groupBy: campaign`.
- Proyecto sin Meta (Yconia): la sección no aparece; el asistente responde "no
  conectado" a una pregunta de gasto.

## Fuera de alcance

Gráficas nuevas; tocar las existentes; conversión de moneda; reparto de gasto entre
proyectos; exponer filas diarias a `aggregate`/`relate`; WhatsApp.
