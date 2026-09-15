# PMI — pestaña "Desempeño": el reporte de la consultoría calculado desde el CRM

Fecha: 2026-09-15
Estado: diseño aprobado para implementar

## El problema

La consultoría (c+escaling) evalúa a los asesores con el **PMI**: un Excel por mes, en
dos niveles — uno **por asesor** (captura diaria a mano: leads, perfilamientos,
recorridos, apartados, cierres, montos, con objetivos y semáforo) y uno **general del
proyecto** (suma de los asesores, ranking de apartados contra la meta, conversiones,
tendencia por semana) más una hoja anual (`DASH`) con meses, trimestres y ranking de
ventas. Se analizaron los cuatro archivos de referencia de Yconia, septiembre 2026:
`PMI Lezgo Yconia.xlsx` / `.pdf` (general) y `Monica Salinas.xlsx` / `.pdf` (asesor).

Todo se captura a mano aunque casi todo está en GHL. La decisión (pregunta 1) es que
**el panel sustituya la captura**: calcula lo que GHL sabe y omite lo que no.

## Decisiones

1. **El panel calcula, no captura.** Rechazado: mostrar el PMI subido tal cual
   (seguiría siendo manual) y el híbrido (dos números para la misma cosa).
2. **Los hitos se definen por NOMBRE de etapa, no por número.** Los cinco proyectos
   inmobiliarios comparten la convención `02. Cliente Calificado`, `06. Apartado`,
   `08. Proceso de Escritura`, pero `10.` es *Negocio Ganado* en Yconia e *Inversión
   Futura* en Condesa, Plaza Bosques, Grand Center y Balvanera. Una regla por número
   contaría inversiones futuras como cierres.
3. **Perfilamiento** = la oportunidad alcanzó *Cliente Calificado* o cualquier etapa
   posterior (cita, visita, inversión futura, cotización, apartado, mensualidades,
   escritura, ganado). Las **perdidas cuentan** si su campo "Última Etapa en el
   Pipeline" es una de esas.
4. **Cita efectiva (= "Recorrido" en el PMI; son el mismo número en los cuatro
   archivos)** = cita de calendario con estado `showed`. Tiene fecha y hora, que es lo
   que permite contarla por día y semana. Rechazado: la etapa *Visita al Desarrollo*
   (sin fecha) y la unión de ambas.
5. **Apartado** = la oportunidad alcanzó *Apartado* o posterior. Es un **evento**, no
   un estado: el PMI cuenta los dos negocios de Eder como apartados de junio *y*
   cierres de julio. Un apartado que después se cae sigue siendo apartado de su mes.
   Monto = `opp.value`.
6. **Cierre** = alcanzó *Proceso de Escritura*, *Siguiente Escritura* o *Negocio
   Ganado*. Cuadra con lo que capturó la consultoría (los cierres de Eder de julio,
   $6,655,971, están hoy en `08. Proceso de Escritura`; su apartado de julio en
   `07. Pago de Mensualidades` todavía no es cierre). Rechazado: solo `Negocio
   Ganado` (5 en Yconia) y `Pago de Mensualidades` en adelante.
   - **Hallazgo:** en Yconia `status: won` se pone desde el apartado — las 61
     oportunidades en `06`–`10` tienen `status: won`. `isWonOpp()` cuenta apartados
     como ganadas; el PMI **no** la usa. El KPI "Ganadas" de Ventas y el CPA de Meta
     sí, y por tanto **hoy cuentan apartados en Yconia**: deuda conocida, fuera de
     esta entrega, anotada en CLAUDE.md.
7. **Las fechas de los hitos salen de una bitácora propia** (`opportunity_milestones`
   en Neon), porque GHL no guarda cuándo una oportunidad entró a una etapa y
   `closedAt` está vacío en las 7,112 de Yconia. Rechazado: `updatedAt` como fecha
   (cualquier edición mueve el hito al mes actual) y webhooks de GHL (receptor +
   configuración por sub-cuenta + pérdida silenciosa de eventos). **Es la primera
   tabla del panel con historia que no se reconstruye desde GHL.**
8. **Lead** = todo contacto nuevo asignado al asesor, con el desglose de cuántos son
   de pauta (`isDePauta`). El PMI dice "Leads Publicidad" pero sus cifras (31/29/32)
   quedan debajo de los contactos nuevos de GHL (37/32/36) y encima de solo-pauta; se
   muestran ambos.
9. **Objetivos fijos por defecto**, iguales para todo asesor y proyecto, en una
   constante. Rechazado: tabla editable (administración que nadie pidió) y
   constante por proyecto. Se afina si hace falta.
10. **Cambaceo y Accountability quedan fuera.** No existen en GHL y este panel no
    tiene cuentas por asesor ni captura manual. Siguen en el Excel si la consultoría
    los necesita.
11. **Los cinco proyectos inmobiliarios desde el inicio**, para que la bitácora
    acumule en todos desde el día uno. Lezgo Suite (pipeline de servicios) no tiene
    etapas que caigan en el vocabulario y no ve la pestaña.
12. **Pestaña propia "Desempeño" con selector de mes / año**, no una sección de
    Ventas: el PMI es mensual por construcción (semanas del mes, objetivo del mes) y
    la barra de fechas global es un rango libre. La barra se oculta ahí, como en el
    Asistente. Incluye la vista anual completa (trimestres, ranking anual, ticket
    promedio, "$ para llegar").
13. **Los hitos viajan pegados a cada `Opportunity`** (`milestones`), y todo el
    cálculo es puro en el navegador (`lib/pmi.ts`), como Marketing y Ventas. Los
    drill-downs y el asistente los ven sin trabajo extra. Rechazado: agregado
    servidor (`payload.pmi`, rompe el patrón client-side y no se abre a registros) y
    guardar la última etapa vista dentro del payload cacheado (el caché es
    desechable; la historia no puede vivir ahí).

## Hitos — `lib/pmi-stages.ts` (puro)

```ts
export type Milestone = "perfilado" | "apartado" | "cierre";
export function effectiveStage(opp: Opportunity): string | null
export function milestonesOfStage(stageName: string): Set<Milestone>
export function projectHasMilestoneStages(pipelines: Pipeline[]): boolean
```

- `effectiveStage`: la etapa actual; si la oportunidad está perdida (`status: lost`
  o etapa "Negocio Perdido"), el custom field `Última Etapa en el Pipeline`
  (`customFieldsResolved`). Si ese valor es a su vez "Negocio Perdido" o falta →
  `null` (sin hitos).
- `milestonesOfStage` normaliza (minúsculas, sin acentos) y busca por substring:

  | Hito | La etapa contiene… |
  |---|---|
  | `perfilado` | calificado · cita · visita · inversion futura · cotizacion · apartado · mensualidades · escritura · ganad |
  | `apartado` | apartado · mensualidades · escritura · ganad |
  | `cierre` | escritura · ganad |

  Los hitos son acumulativos: una etapa de cierre también es apartado y perfilado.
  "Visita Al Desarrollo" (Plaza Bosques) y "Visita al Desarrollo" (Yconia) caen
  igual. "Lead Recibido (Ventas)", "1er Contacto", "Last Call", "Renta", "Prospecto
  Perdido" no caen en nada.
- `projectHasMilestoneStages`: alguna etapa de algún pipeline del proyecto cae en el
  vocabulario. Decide si la pestaña se dibuja (presencia, igual que `SEGMENT_DEFS`).

## Bitácora — `opportunity_milestones`

```sql
CREATE TABLE IF NOT EXISTS opportunity_milestones (
  project_id     TEXT        NOT NULL,
  opportunity_id TEXT        NOT NULL,
  milestone      TEXT        NOT NULL,   -- perfilado | apartado | cierre
  reached_at     TIMESTAMPTZ NOT NULL,
  estimated      BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (project_id, opportunity_id, milestone)
);
```

Se crea en `scripts/db-migrate.ts` (idempotente, como las otras tres). Una fila por
hito alcanzado; **nunca se actualiza ni se borra** desde la app. Solo guarda ids y
fechas — sin datos personales — y **no es desechable**: borrarla pierde la fecha de
cada hito para siempre. Debe respaldarse con la base.

### Reconciliación — `lib/pmi-ledger.ts` (puro) + `lib/pmi-ledger-store.ts` (SQL)

```ts
export interface MilestoneRow { opportunityId: string; milestone: Milestone; reachedAt: string; estimated: boolean }
export interface OpportunityMilestones { perfilado?: string; apartado?: string; cierre?: string; estimated?: boolean }
export function reconcileMilestones(
  existing: MilestoneRow[], opps: Opportunity[], now: Date,
): { inserts: MilestoneRow[]; byOpportunity: Map<string, OpportunityMilestones> }
```

- Para cada oportunidad, `milestonesOfStage(effectiveStage(opp))`. Cada hito sin
  fila → `inserts` con `reachedAt = now`, `estimated = false`.
- **Primera vez** (`existing` vacío para el proyecto): `reachedAt = opp.updatedAt ??
  opp.createdAt`, `estimated = true`. No hay historia y es lo mejor que GHL da. Vale
  para todos los hitos de esa oportunidad.
- Una fila existente **manda** sobre la etapa actual: si la oportunidad retrocedió
  o se perdió, el hito sigue (decisión 5).
- `byOpportunity` fusiona filas existentes + inserts; `estimated` es `true` si
  cualquiera de sus hitos lo es.
- `readMilestones(client)` / `insertMilestones(client, rows)` en el store; el insert
  es `ON CONFLICT DO NOTHING` (dos syncs concurrentes no duplican ni fallan).

### En `syncProject` (`lib/sync.ts`)

Justo después del transform de oportunidades (y del copiado de atribución desde el
contacto), antes de Meta Ads:

1. `existing = await readMilestones(client)` (una consulta; ~500 filas en Yconia).
2. `reconcileMilestones(existing, opportunities, new Date())`.
3. `await insertMilestones(client, inserts)` si hay.
4. `opp.milestones = byOpportunity.get(opp.id)` para cada oportunidad.

Un solo lugar sirve al camino en vivo y al refresco en segundo plano. **Si la base
falla** en 1 o 3: se registra (`console.error`), se vuelve a reconciliar con
`existing = []` y `estimated = true` para que el payload salga completo, y **no** se
inserta nada (la siguiente corrida con base sana hace el backfill real). El sync no
muere por la bitácora — la misma regla que para todo lo demás con Postgres.

`Opportunity` gana `milestones?: OpportunityMilestones` en `lib/types.ts`. Un payload
cacheado anterior a este cambio no lo trae: `lib/pmi.ts` trata `milestones`
ausente como "sin hitos" y la pestaña muestra ceros hasta el siguiente sync, no un
error.

## Motor — `lib/pmi.ts` (puro, navegador)

```ts
export const PMI_OBJECTIVES = {
  leads: 40, perfilamientos: 16, citas: 8,
  apartados: 2, montoApartados: 3_000_000,
  cierres: 2, montoCierres: 3_000_000,
} as const;                                   // por asesor, por mes
export const PMI_CONVERSION_TARGETS = { leadPerfil: 0.40, perfilCita: 0.60, citaApartado: 0.75, apartadoCierre: 1.00 };
export const PMI_BANDS = { alto: 1.8, medio: 1.0, bajo: 0.75 };  // × objetivo

export function monthWeeks(month: string /* YYYY-MM */): PmiWeek[]
export function buildPmiMonth(input: PmiInput, month: string): PmiMonth
export function buildPmiYear(input: PmiInput, year: number): PmiYear
export function semaphore(value: number, objective: number): "alto" | "medio" | "bajo" | null
```

`PmiInput = { contacts, opportunities, appointments, pautas }` — el dataset completo,
sin filtros. Todo por día **local** (`localDay`, `America/Mexico_City`), la misma
regla de `drill-export` y Meta.

- **Semanas:** lunes a domingo recortadas al mes; un pedazo de **menos de 4 días** se
  pega a la semana vecina. Reproduce las del PMI: septiembre 2026 `1-6 · 7-13 · 14-20
  · 21-30`, agosto `1-9 · 10-16 · 17-23 · 24-31`, julio cinco semanas `1-5 … 27-31`.
- **Indicadores** — registro, fecha, asesor:

  | Indicador | Registro | Fecha | Asesor |
  |---|---|---|---|
  | leads (+ leadsPauta) | contacto | `createdAt` | `contact.assignedTo` |
  | perfilamientos | oportunidad | `milestones.perfilado` | `opp.assignedTo` |
  | citas | cita con `status === "showed"` | `startTime` | `appointment.assignedTo` |
  | apartados, montoApartados | oportunidad | `milestones.apartado` | `opp.assignedTo` |
  | cierres, montoCierres | oportunidad | `milestones.cierre` | `opp.assignedTo` |

  Monto = `opp.value`. `leadsPauta` = `isDePauta` sobre las oportunidades del
  contacto **o** contacto ligado a un objeto Pauta (la unión de `lib/pauta.ts`).
- **Asesores** = valores distintos de `assignedTo` con al menos un registro en el
  período. Vacío / ausente → fila "Sin asignar", visible solo si no es cero, fuera
  del ranking y del cálculo de objetivos de equipo.
- **Objetivos:** semanal = mes ÷ 4 (aunque el mes tenga 5 semanas: así lo hace el
  Excel), diario = semanal ÷ 7. Equipo = objetivo × asesores activos del período.
- **Semáforo** (sacado de las fórmulas del Excel, `E7=E8*180%`, `E9=E8*75%`): `alto`
  ≥ 180 % del objetivo, `medio` ≥ 100 %, `bajo` ≥ 75 %, debajo `null` (sin color).
  Aplica igual a día, semana y mes contra su objetivo respectivo. Objetivo 0 → `null`.
- **Conversiones:** leadPerfil, perfilCita, citaApartado, apartadoCierre = cociente
  de los totales del período. Denominador 0 → `null`, **nunca 0 %**.
- **Ranking del mes:** asesores por `montoApartados` desc con `avance =
  monto ÷ 3,000,000`; el mismo para cierres.
- **`PmiMonth`:** `{ month, weeks, days, team: PmiSlice, advisors: PmiAdvisor[],
  unassigned: PmiSlice | null, rankingApartados, rankingCierres, estimatedCount }`.
  `PmiSlice = { byWeek: PmiCounts[], byDay: PmiCounts[], total: PmiCounts,
  objectives, conversions }`. Cada `PmiCounts` guarda los **ids** de sus registros
  (contactos, oportunidades, citas) para el drill-down.
- **`PmiYear`:** por asesor, `byMonth: PmiCounts[12]`, `byQuarter[4]`, `total`,
  `mesesActivo` (meses con algún registro), `promedioMensual`, `ticketPromedio =
  montoCierres ÷ cierres` (`null` sin cierres), `avanceMeta = montoApartados ÷
  (3,000,000 × mesesActivo)`, `paraLlegar = max(0, meta − monto)`; y para el equipo
  los totales por mes y trimestre con `% meta` (objetivo del mes × asesores activos
  ese mes). Rankings anuales de apartados y cierres por monto.
- **`estimatedCount`:** hitos del período con `estimated`. La UI y el PDF lo dicen.

## Pestaña — `components/dashboard/pmi-dashboard.tsx`

- `DashboardTab` gana `"pmi"`, etiqueta **Desempeño**, cuarta pestaña. Se ofrece
  solo si `projectHasMilestoneStages(data.pipelines)`; `activeTab === "pmi"` oculta
  la `FilterBar` como `"conversations"`. Recibe el dataset completo (`data`), no el
  filtrado. Se monta condicionalmente (no guarda estado que valga la pena conservar).
- **Cabecera propia:** `◀ Septiembre 2026 ▶` (default: mes actual local), conmutador
  **Mes / Año**, selector **Equipo | <asesores activos>**, botón **Exportar PDF**. El
  estado (`period`, `advisor`) vive en el componente.
- **Vista Equipo (mes):**
  1. Cinco tiles: Leads (con "n de pauta"), Perfilamientos, Citas efectivas, Apartados
     (conteo + monto), Cierres (conteo + monto). Cada uno con objetivo de equipo, % de
     avance y tono del semáforo.
  2. Tira de conversiones: las cuatro, resultado vs meta, `—` cuando es `null`.
  3. **Indicadores × semana** (`pmi-week-table.tsx`): filas = 7 indicadores, columnas
     = semanas + total + % objetivo; celdas teñidas por semáforo. Clic → drawer
     (`chart-drill-drawer`) con los registros de esa celda.
  4. **Por asesor:** leads · perfil · citas · apartados · cierres · montos, y sus
     cuatro conversiones. Clic en la fila → `advisor = ese`.
  5. Ranking de apartados por monto: barras por asesor con línea de META a $3M; el
     mismo para cierres. Clic → drawer con las oportunidades.
  6. Perfilamientos y citas efectivas por semana, dos gráficas de línea.
- **Vista Asesor (mes)** (`pmi-advisor-sheet.tsx`): mismos tiles y conversiones del
  asesor, más la **cuadrícula diaria** — indicadores × días agrupados por semana,
  celda teñida por semáforo diario, columna de total por semana — que es la ficha del
  PDF individual. Clic en un día → drawer.
- **Vista Año** (`pmi-year-table.tsx`): una tabla asesor × mes por indicador (con
  selector del indicador), totales por trimestre y `% meta` por mes; ranking anual de
  apartados y de cierres con avance, "$ para llegar", meses activo, promedio mensual y
  ticket promedio.
- Aviso discreto sobre cualquier vista cuando `estimatedCount > 0`: "N hitos con fecha
  estimada (anteriores al arranque de la bitácora, el <fecha del primer sync>)".
- Convenciones: `ChartCardHeader` + `ScopePill` en cada bloque con la regla ("Apartado
  = primera vez en etapa Apartado o posterior; perdidas por última etapa"),
  `NonZeroTooltipContent`, sin leyendas, sin scroll dentro de cards, ámbar solo donde
  va la atención, `useMemo` sobre `data.opportunities` por referencia.

## PDF — `lib/pmi-report.ts`

`buildPmiReport(pmi, { variant: "month-team" | "month-advisor" | "year", advisor?
})` compone un `ReportInput` (KPIs + `ReportSection[]`) en el estilo de
`lib/report.ts`, sobre los mismos `lib/pdf/*` (LETTER apaisado, `sanitizeBrand`).
Secciones: tiles como KPIs; tabla indicadores × semana (o × mes en año); tabla por
asesor; ranking como gráfica de barras; tendencia por semana como líneas; en asesor,
la cuadrícula diaria como tabla. `periodLabel` = "Septiembre 2026" / "2026",
`filtersLabel` = "Asesor: Mónica Salinas" cuando aplica, para que `analyze-report` no
lea a una persona como si fuera el equipo. Pasa por `analyze-report` por defecto como
los otros dos; ~6 secciones, dentro del presupuesto de tokens actual.

## Verificación

- `pnpm verify:pmi-ledger` — `reconcileMilestones`: bitácora vacía → `updatedAt` +
  `estimated`; con filas → solo inserta las nuevas con `now`; un hito no se retira al
  retroceder o perder; perdida con última etapa cualifica; `effectiveStage` con
  "Negocio Perdido" en el campo → sin hitos. Roundtrip contra Postgres con ids
  `__verify_*` (imposibles en el roster) solo si hay `DATABASE_URL`, borrados al
  terminar — el patrón de `verify:sync-store`.
- `pnpm verify:pmi` — `monthWeeks` para julio/agosto/septiembre 2026; hitos por
  nombre en los cinco pipelines reales (incluido `10. Inversión Futura` ≠ cierre);
  bandas del semáforo en los bordes (75 %, 100 %, 180 %); conversiones `null` con
  denominador 0; montos; ranking; trimestres y `mesesActivo`; `estimatedCount`.
- `pnpm verify:sync-store` sigue verde (la reconciliación no toca `project_sync`).
- `npx tsc --noEmit`, y la app real: Yconia, septiembre 2026, contra el PMI de la
  consultoría — la fila de referencia es Arely **29 / 8 / 5 / 1 / $3,988,119.69**.
  Leads saldrán un poco arriba (GHL 32) por la definición "todos"; se documenta.

## Despliegue

`pnpm db:migrate` local y en producción **antes** del deploy. Sin env vars nuevas.
El primer sync de cada proyecto hace el backfill estimado; **octubre 2026 es el primer
mes con fechas exactas**.

## Riesgos asumidos

1. **El primer mes es estimado** (`updatedAt`). El aviso en pantalla lo dice.
2. **`isWonOpp()` cuenta apartados en Yconia** (decisión 6). No se toca aquí; queda
   como deuda en CLAUDE.md.
3. **Citas sin `assignedTo`** caen en "Sin asignar", no en el asesor de la
   oportunidad. Si pesa, el siguiente paso es heredar el asesor del contacto.

## Fuera de alcance

Cambaceo, Accountability, objetivos editables, integración con el asistente (ve
`opp.milestones` en los datos, pero sin herramienta ni regla nueva), corregir
`isWonOpp()` para Yconia.
