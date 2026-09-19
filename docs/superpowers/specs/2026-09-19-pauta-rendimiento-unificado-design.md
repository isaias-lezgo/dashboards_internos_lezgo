# Inversión y rendimiento de pauta — una tabla en lugar de cinco piezas

Fecha: 2026-09-19
Estado: diseño aprobado, pendiente de plan

## El problema

La pestaña Marketing cuenta la misma historia —qué pauta trae qué— en cinco piezas
que no se hablan entre sí:

| Pieza | Universo | Llave | Qué muestra |
|---|---|---|---|
| Inversión en pauta (tabla) | Meta (`exact`) | campaña de Meta | gasto, impr., clics, CPM, CTR, leads, opps, ganadas, CPL, CPA |
| Oportunidades de pauta por etapa (apilada) | CRM (`isDePauta`) | campaña / URL / ID / origen | opps por etapa, apiladas por llave |
| Oportunidades por ID de anuncio (lista) | CRM | ad id | opps por ad id |
| Oportunidades por URL (lista) | CRM | `attributionUrl` | opps por liga, fb / ig |
| Citas por pauta (barras) | CRM | campaña / URL / ID / origen | contactos con cita por llave |

La apilada con 30 campañas es ilegible (30 colores, leyenda de cuatro renglones,
una barra de "Prospecto Perdido" que aplasta el resto). Las dos listas no dicen a qué
campaña pertenece cada id o liga. Y para saber cuánto costó una campaña que produjo
citas hay que leer dos tarjetas y cruzarlas de cabeza.

Las cinco no miran el mismo universo: la tabla parte de Meta y descarta lo que no
cruza (TikTok, Google, opps sin ad id); las cuatro gráficas parten del CRM y no saben
de costos. Y hoy solo Lezgo Suite tiene Meta conectado, así que en cinco de seis
proyectos la tabla ni se dibuja.

## Decisiones

1. **Una tabla, sobre el universo del CRM, con Meta encima.** Las filas son las
   pautas del CRM (`isDePauta`: Meta, TikTok, Google, con o sin cruce). Las columnas
   de inversión (gasto, impresiones, clics, CPM, CTR, CPL, CPA) se suman cuando hay
   `metaAds` y cruce por ad id, y no existen cuando no. Es lo contrario de la tabla
   actual, que parte de Meta. Rechazado: extender solo la tabla de Meta (cinco
   proyectos perderían etapas, IDs, URLs y citas al jubilar las gráficas) y dos
   tablas separadas (seguirían sin cruzarse costos con citas).
2. **El átomo es el anuncio (ad id).** Es la llave de Meta y es lo que trae la
   oportunidad; URL, etapa y cita cuelgan de la oportunidad / contacto, que cuelgan
   del ad id. El ad id de una oportunidad sale de la MISMA cadena que usa Meta
   (`resolveOppAdId`: propio → objeto Pauta del contacto → primera atribución →
   última), para que "Opps" en esta tabla y "Opps" bajo el CPL cuenten lo mismo.
   Sin Meta la cadena corre con un índice vacío y devuelve el primer id crudo
   (`resolveChain` ya se comporta así); no hay un segundo camino.
3. **Filas expandibles: grupo → anuncios.** ID y URL son atributos del anuncio, no
   de la campaña; se ven al expandir, en contexto, sin cambiar de modo. Rechazado:
   una tabla plana con toggle Campaña | Anuncio | URL | Origen — para ver los
   anuncios de UNA campaña habría que cambiar de modo y buscarla.
4. **Grupo = Campaña u Origen** (toggle). Con Meta, la campaña de un anuncio es la de
   Meta (la jerarquía real, de la que sale el gasto). Si el anuncio no cruza con Meta
   —o no hay Meta— la campaña es el *headline* de la pauta del CRM
   (`campaignHeadline(resolveCampaignName(...))`, la misma regla del toggle de
   Montse). Un grupo sin cruce lleva la marca "sin Meta". Origen = `platformLabel`.
5. **Los hijos de una campaña de Meta son la UNIÓN** de sus anuncios en Meta y los ad
   ids que trae el CRM. Un anuncio con gasto y cero leads aparece (opps en 0); sin
   él la suma de los hijos no daría el gasto de la campaña, y el gasto de la
   campaña debe ser idéntico al de `buildMetaReport({ groupBy: "campaign" })`, que
   está cuadrado al peso contra el Administrador de anuncios.
6. **Una oportunidad sin ad id no desaparece**: cae en un hijo "Sin ID de anuncio"
   dentro de su grupo. Un cero por omisión es una respuesta falsa.
7. **Las etapas van como barra de embudo en la fila**, no como columnas: segmentos
   en orden del pipeline, perdidas aparte al final y fuera con el toggle. Rechazado:
   una columna numérica por etapa (Lezgo Suite tiene 9; la tabla se ensancharía y
   habría que elegir cuáles). El número exacto está en el hover y en el drill.
8. **Citas y Efectivas son dos columnas**, no un desplegable de estatus. Citas =
   contactos con al menos una cita en la ventana (dos citas del mismo contacto
   cuentan 1, como hoy); Efectivas = con al menos una `showed`. Es el vocabulario
   del PMI.
9. **Las reglas de Meta se heredan tal cual**: cohorte por día local, CPL/CPA en `—`
   con filtros de atributo (`costsSuppressed`), moneda mixta apaga costos
   consolidados, `unknownAd` no entra al costo.
10. **Un motor puro nuevo, `lib/paid-performance.ts`.** Rechazado: estirar
    `buildMetaReport` (es Meta-first por diseño y lo comparte `meta_ads_report` del
    asistente: cambiarle el universo cambia en silencio lo que el asistente
    responde) y memos en `marketing-dashboard.tsx` (2,556 líneas; es lo que hace
    irreconciliables a las cuatro gráficas de hoy).
11. **El asistente no cambia.** `meta_ads_report` sigue sobre `buildMetaReport`.
    Exponerle este motor es una entrega aparte.
12. **En modo Origen no hay columnas de inversión.** El gasto de Meta vive por
    anuncio, y un anuncio produce a la vez oportunidades de Instagram, Facebook y
    WhatsApp (`platformLabel` es por oportunidad): repartir su gasto entre orígenes
    sería inventar un número. En Origen se ven leads, opps, ganadas, citas y etapas;
    el `ScopePill` dice por qué no hay gasto.

## El motor — `lib/paid-performance.ts` (puro, navegador)

```ts
export interface PaidPerformanceInput {
  /** Recortados por fecha Y atributos, como llegan al dashboard. */
  opportunities: Opportunity[]
  contacts: Contact[]
  appointments: Appointment[]
  /** Historial completo: la cadena de atribución y los joins miran todo. */
  allContacts: Contact[]
  allOpportunities: Opportunity[]
  allPautas: Pauta[]
  pipelines: Pipeline[]
  pautaContacts: HasKey            // la señal de isDePauta
  pautaNameByContact: Map<string, string>
  groupBy: "campaign" | "platform"
  includeLost: boolean
  /** null = sin Meta: sin columnas de inversión. */
  meta: { data: MetaAdsData; index: MetaIndex; range: DayRange; costsSuppressed: boolean } | null
}

export interface StageCount { stageId: string; name: string; order: number; lost: boolean; count: number }

export interface PaidRow {
  key: string
  label: string
  /** Solo en hijos. */
  adId: string | null
  /** La liga más frecuente entre sus oportunidades, y cuántas distintas hay. */
  url: { href: string; platform: "facebook" | "instagram" | "other"; others: number } | null
  /** false en un grupo de Meta; true en uno del CRM (sin cruce o sin Meta). */
  crmOnly: boolean
  // Inversión — null sin Meta o sin cruce; currency "?" con monedas mezcladas.
  currency: string | null
  spend: number | null
  impressions: number | null
  clicks: number | null
  cpm: number | null
  ctr: number | null
  leadsMeta: number | null
  cpl: number | null
  cpa: number | null
  // CRM
  leadsCrm: number
  opportunities: number
  won: number
  appointments: number        // contactos con cita
  showed: number              // contactos con cita showed
  stages: StageCount[]        // suma = opportunities (con includeLost)
  // Drill: los ids, sin tope (el drawer abre los 64 de una campaña con 64).
  oppIds: string[]
  contactIds: string[]
  apptContactIds: string[]
}

export interface PaidGroup extends PaidRow { children: PaidRow[] }

export function buildPaidPerformance(p: PaidPerformanceInput): PaidGroup[]
```

- **Ad id por oportunidad**: `resolveOppAdId(opp, ctx)`. `ctx` es
  `buildAttributionContext` con el índice real o, sin Meta, con
  `buildMetaIndex({ accounts: [], campaigns: [], adsets: [], ads: [], daily: [] })`.
  Se construye una vez por payload y se comparte con `useMetaInvestment`.
- **Contactos (Leads CRM)** por `contactAdId(c, ctx)`, la misma cadena que
  `buildCostSummary`. Un contacto sin ad id va al hijo "Sin ID" del grupo que le dé
  su primera pauta (`pautaNameByContact`) o su origen.
- **Inversión por hijo**: `buildMetaReport({ groupBy: "ad", includeIds: false })`
  indexado por `key` (ad id). El grupo suma sus hijos; CPM/CTR/CPL/CPA se recalculan
  del agregado, nunca se promedian. Con `costsSuppressed` el motor sigue devolviendo
  `cpl`/`cpa`; es la UI la que los pinta `—` (misma división de responsabilidades
  que hoy).
- **Etapas**: `Pipeline` da el orden; una oportunidad perdida cuenta en su etapa
  con `lost: true`. `includeLost: false` la excluye de `stages`, `opportunities` y
  `oppIds`, exactamente como el toggle de hoy.
- **Citas**: `appointments` (ya recortadas por fecha) → `Set` de `contactId`;
  `showed` por `status === "showed"`. Una cita cuenta para la fila de su contacto.
- **Orden**: el motor no ordena; devuelve grupos e hijos en orden de inserción y la
  UI ordena por la columna activa. El "Top N" y la fila "Otras" también son de la UI.
- **En `groupBy: "platform"`** el motor no llama a `buildMetaReport`: inversión
  `null` en todas las filas, `crmOnly` según haya cruce (para la marca) — decisión 12.
- **Sin Meta** (`meta: null`): todos los campos de inversión son `null`, `crmOnly`
  es `true` en todo, y las filas son las que da el CRM. Es el mismo código.

## La tarjeta — `components/dashboard/paid-performance-table.tsx`

Una sola tarjeta, "Inversión y rendimiento de pauta", que reemplaza a "Inversión en
pauta" y a las cuatro gráficas.

- **Tiles**: los seis de hoy (Gasto, Leads CRM, CPL, Oportunidades, Ganadas, CPA)
  **solo con Meta**. Siguen viviendo en `meta-investment-section.tsx` con
  `useMetaInvestment`; esa sección pierde su tabla. Sin Meta la tarjeta empieza en
  la tabla.
- **Controles del encabezado**, en este orden: toggle **Campaña | Origen** ·
  **buscador** de texto sobre el nombre del grupo (reemplaza `GroupKeyFilter`) ·
  **Top N** (`TopNSlider`; la fila "Otras (n)" agrega el resto y no se expande) ·
  toggle **Perdidas** · **Expandir / colapsar todo** · **Columnas** · `ScopePill`.
- **Editor de columnas**: popover con casillas en cuatro grupos — *Inversión*
  (Gasto, Impr., Clics, CPM, CTR) · *Leads y costo* (Leads Meta, Leads CRM, Opps,
  Ganadas, CPL, CPA) · *Citas* (Citas, Efectivas) · *Etapas*. Nombre, ID y URL no se
  apagan. Por defecto todo encendido menos Impr., Clics y CPM. Sin Meta los grupos
  *Inversión* y Leads Meta / CPL / CPA no se ofrecen. La selección se guarda en
  `localStorage` (`paid-performance-cols`): conveniencia por navegador, no estado
  del negocio; si falla la lectura, el default.
- **Ordenamiento**: clic en un encabezado numérico ordena grupos e hijos; segundo
  clic invierte. Default Gasto ↓ con Meta, Opps ↓ sin Meta. "Otras" siempre al
  final.
- **Filas expandibles**: chevron al inicio; un grupo con un solo hijo no se expande —
  sería una fila repetida — y muestra el ID y la URL de ese hijo en su propia fila. Hijos indentados: ID en monoespaciado con `CopyButton`;
  URL acortada (`ig.me/DWWkb…`) con icono fb / ig y apertura en pestaña nueva; con
  varias ligas, la más frecuente y "+n" (el drill las muestra todas). Un grupo
  `crmOnly` lleva una píldora tenue "sin Meta".
- **Barra de etapas**: segmentos proporcionales dentro de la fila, tono de claro a
  oscuro en orden del pipeline, perdidas en rojo apagado al final. Hover = etapa y
  cuenta. Sin oportunidades, celda vacía. No lleva leyenda: el hover decodifica.
- **Drill-downs — cada número abre sus registros** vía `ChartDrillDrawer`, con los
  joins contra el historial completo: Nombre → oportunidades de la fila ·
  Leads CRM → contactos · Citas / Efectivas → oportunidades de esos contactos ·
  Ganadas → ganadas · segmento de etapa → oportunidades de esa etapa.
- **Vacío**: sin pautas en la ventana, "Sin oportunidades de pauta en la ventana".

## PDF

- Se retiran `pauta-etapa`, `anuncios`, `urls` y `citas-pauta`. Marketing baja de 13
  a 9 secciones; el presupuesto de `analyze-report` (8,000 tokens) sobra.
- `meta-investment` pasa a "Inversión y rendimiento de pauta" y se construye desde
  `buildPaidPerformance` (grupos, top 15): las columnas de hoy más Citas y
  Efectivas; sin Meta, sin las columnas de costo. Los KPIs de portada
  (`metaCoverKpis`) no cambian.
- Las etapas no van como barra: una tabla anexa "Oportunidades de pauta por etapa"
  con una fila por etapa y una columna por cada una de las top 6 campañas más
  "Otras". En papel, una tabla se lee; una apilada de 30 colores no.
- `buildMetaReportSection` deja de existir; la sección la construye
  `paid-performance-table.tsx` (junto a su UI, para que pantalla y PDF no diverjan
  en qué es "rendimiento de pauta").

## Qué se va

- Tarjetas: "Oportunidades de Pauta por Etapa del Pipeline", "Oportunidades por ID
  de Anuncio", "Oportunidades por URL (Facebook / Instagram)", "Citas por pauta", y
  la tabla de "Inversión en pauta".
- Estado y memos de `marketing-dashboard.tsx`: `stageGroupBy`, `stageKeys`,
  `stageTopN`, `stageIncludeLost`, `pautaByStage*`, `leadsByAdId`,
  `leadsByPlatformUrl`, `apptGroupBy`, `apptKeys`, `apptTopN`, `apptStatusFilter`,
  `paidTrafficWithAppt`. `GroupByToggle`, `GroupKeyFilter`, `paidGroupByKey` y
  `campaignPrefixCut` se quedan mientras los usen "Perdidas por razón" y "Ganadas
  por pauta".
- `urlPlatform` se muda a `lib/paid-performance.ts` (la tabla lo necesita para el
  icono).

## Verificación

`pnpm verify:paid-performance` (`scripts/verify-paid-performance.ts`,
`node:assert/strict` vía `tsx`, `main().catch(...)`) sobre datos sintéticos:

1. El `spend` de cada grupo de Meta es idéntico al de
   `buildMetaReport({ groupBy: "campaign" })` con la misma entrada.
2. Un anuncio con gasto y sin leads aparece como hijo con `opportunities: 0`.
3. Una oportunidad de TikTok sin ad id sobrevive como hijo "Sin ID" de su grupo, con
   inversión `null` y `crmOnly: true`.
4. `stages` suma `opportunities`, con y sin `includeLost`.
5. Con `meta: null` salen los mismos grupos del CRM sin inversión.
6. Dos citas del mismo contacto cuentan 1 en `appointments`; `showed` cuenta solo
   `status === "showed"`.
7. Una oportunidad cuyo ad id propio no está en Meta pero el de su contacto sí se
   cuenta bajo la campaña de Meta (la cadena manda, no el campo crudo).

Luego se maneja la app real: Lezgo Suite (con Meta: el gasto por campaña contra la
tabla de hoy antes de borrarla) y Condesa (sin Meta), y se exporta el PDF de ambas.
`npx tsc --noEmit` antes de commitear: `next build` ignora los errores de tipos.

## Fuera de alcance

- Exponer el motor al asistente (`meta_ads_report` sigue igual).
- Tocar "Perdidas por razón" y "Ganadas por pauta", que comparten `GroupByToggle`.
- Objetivos o semáforo por campaña.
- Persistir la configuración de columnas en la base.
